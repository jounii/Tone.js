import { Time, TimeClass } from "../../core/type/Time";
import { PlaybackState } from "../../core/util/StateTimeline";
import { Signal } from "../../signal/Signal";
import { onContextClose, onContextInit } from "../context/ContextInitialization";
import { Gain } from "../context/Gain";
import { Param } from "../context/Param";
import { ToneWithContext, ToneWithContextOptions } from "../context/ToneWithContext";
import { TicksClass } from "../type/Ticks";
import { TransportTimeClass } from "../type/TransportTime";
import { optionsFromArguments } from "../util/Defaults";
import { Emitter } from "../util/Emitter";
import { readOnly, writable } from "../util/Interface";
import { IntervalTimeline } from "../util/IntervalTimeline";
import { Timeline } from "../util/Timeline";
import { isArray, isDefined } from "../util/TypeCheck";
import { Clock } from "./Clock";
import { TransportEvent } from "./TransportEvent";
import { TransportRepeatEvent } from "./TransportRepeatEvent";

interface TransportOptions extends ToneWithContextOptions {
	bpm: BPM;
	swing: NormalRange;
	swingSubdivision: Subdivision;
	timeSignature: number;
	loopStart: Time;
	loopEnd: Time;
	ppq: number;
}

type TransportEventNames = "start" | "stop" | "pause" | "loop" | "loopEnd" | "loopStart";

interface SyncedSignalEvent {
	signal: Signal;
	initial: number;
	ratio: Gain;
}

type TransportCallback = (time: Seconds) => void;

/**
 * Transport for timing musical events.
 * Supports tempo curves and time changes. Unlike browser-based timing (setInterval, requestAnimationFrame)
 * Transport timing events pass in the exact time of the scheduled event
 * in the argument of the callback function. Pass that time value to the object
 * you're scheduling. <br><br>
 * A single transport is created for you when the library is initialized.
 * <br><br>
 * The transport emits the events: "start", "stop", "pause", and "loop" which are
 * called with the time of that event as the argument.
 *
 * @example
 * //repeated event every 8th note
 * Transport.scheduleRepeat(function(time){
 * 	//do something with the time
 * }, "8n");
 * @example
 * //schedule an event on the 16th measure
 * Transport.schedule(function(time){
 * 	//do something with the time
 * }, "16:0:0");
 */
export class Transport extends ToneWithContext<TransportOptions> implements Emitter<TransportEventNames> {

	name = "Transport";

	///////////////////////////////////////////////////////////////////////
	// 	LOOPING
	//////////////////////////////////////////////////////////////////////

	/**
	 * 	If the transport loops or not.
	 */
	loop: boolean = false;

	/**
	 * 	The loop start position in ticks
	 */
	private _loopStart: Ticks = 0;

	/**
	 * 	The loop end position in ticks
	 */
	private _loopEnd: Ticks = 0;

	///////////////////////////////////////////////////////////////////////
	// 	CLOCK/TEMPO
	//////////////////////////////////////////////////////////////////////

	/**
	 *  Pulses per quarter is the number of ticks per quarter note.
	 */
	private _ppq: number;

	/**
	 *  watches the main oscillator for timing ticks
	 *  initially starts at 120bpm
	 */
	private _clock: Clock<BPM>;

	/**
	 * The Beats Per Minute of the Transport.
	 * @example
	 * Transport.bpm.value = 80;
	 * //ramp the bpm to 120 over 10 seconds
	 * Transport.bpm.rampTo(120, 10);
	 */
	bpm: Param<BPM>;

	/**
	 *  The time signature, or more accurately the numerator
	 *  of the time signature over a denominator of 4.
	 */
	private _timeSignature: number;

	///////////////////////////////////////////////////////////////////////
	// 	TIMELINE EVENTS
	//////////////////////////////////////////////////////////////////////

	/**
	 *  All the events in an object to keep track by ID
	 */
	private _scheduledEvents = {};

	/**
	 * 	The scheduled events.
	 */
	private _timeline: Timeline<TransportEvent> = new Timeline();

	/**
	 *  Repeated events
	 */
	private _repeatedEvents: IntervalTimeline = new IntervalTimeline();

	/**
	 *  All of the synced Signals
	 */
	private _syncedSignals: SyncedSignalEvent[] = [];

	///////////////////////////////////////////////////////////////////////
	// 	SWING
	//////////////////////////////////////////////////////////////////////

	/**
	 *  The subdivision of the swing
	 */
	private _swingTicks: Ticks;

	/**
	 *  The swing amount
	 */
	private _swingAmount: NormalRange = 0;

	constructor(options?: Partial<TransportOptions>);
	constructor() {

		super(optionsFromArguments(Transport.getDefaults(), arguments));
		const options = optionsFromArguments(Transport.getDefaults(), arguments);

		// CLOCK/TEMPO
		this._ppq = options.ppq;
		this._clock = new Clock({
			callback : this._processTick.bind(this),
			context: this.context,
			frequency : 0,
			units: "bpm",
		});
		this._bindClockEvents();
		this.bpm = this._clock.frequency;
		this._clock.frequency.multiplier = options.ppq;
		this.bpm.value = options.bpm;
		readOnly(this, "bpm");
		this._timeSignature = options.timeSignature;

		// SWING
		this._swingTicks = options.ppq / 2; // 8n
	}

	static getDefaults(): TransportOptions {
		return Object.assign(ToneWithContext.getDefaults(), {
			bpm: 120,
			loopEnd: "4m" as Subdivision,
			loopStart: 0,
			ppq: 192,
			swing: 0,
			swingSubdivision: "8n" as Subdivision,
			timeSignature: 4,
		});
	}

	///////////////////////////////////////////////////////////////////////////////
	// 	TICKS
	///////////////////////////////////////////////////////////////////////////////

	/**
	 *  called on every tick
	 *  @param  tickTime clock relative tick time
	 *  @private
	 */
	private _processTick(tickTime: Seconds, ticks: Ticks): void {
		// handle swing
		if (this._swingAmount > 0 &&
			ticks % this._ppq !== 0 && // not on a downbeat
			ticks % (this._swingTicks * 2) !== 0) {
			// add some swing
			const progress = (ticks % (this._swingTicks * 2)) / (this._swingTicks * 2);
			const amount = Math.sin((progress) * Math.PI) * this._swingAmount;
			tickTime += new TicksClass(this.context, this._swingTicks * 2 / 3).toSeconds() * amount;
		}
		// do the loop test
		if (this.loop) {
			if (ticks >= this._loopEnd) {
				this.emit("loopEnd", tickTime);
				this._clock.setTicksAtTime(this._loopStart, tickTime);
				ticks = this._loopStart;
				this.emit("loopStart", tickTime, this._clock.getSecondsAtTime(tickTime));
				this.emit("loop", tickTime);
			}
		}
		// invoke the timeline events scheduled on this tick
		this._timeline.forEachAtTime(ticks, event => event.invoke(tickTime));
	}

	///////////////////////////////////////////////////////////////////////////////
	// 	SCHEDULABLE EVENTS
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Schedule an event along the timeline.
	 * @param callback The callback to be invoked at the time.
	 * @param time The time to invoke the callback at.
	 * @return The id of the event which can be used for canceling the event.
	 * @example
	 * //trigger the callback when the Transport reaches the desired time
	 * Transport.schedule(function(time){
	 * 	envelope.triggerAttack(time);
	 * }, "128i");
	 */
	schedule(callback: TransportCallback, time: TransportTime | TransportTimeClass): number {
		const event = new TransportEvent(this, {
			callback,
			time : new TransportTimeClass(this.context, time).toTicks(),
		});
		return this._addEvent(event, this._timeline);
	}

	/**
	 * Schedule a repeated event along the timeline. The event will fire
	 * at the `interval` starting at the `startTime` and for the specified
	 * `duration`.
	 * @param  callback   The callback to invoke.
	 * @param  interval   The duration between successive callbacks. Must be a positive number.
	 * @param  startTime  When along the timeline the events should start being invoked.
	 * @param  duration How long the event should repeat.
	 * @return  The ID of the scheduled event. Use this to cancel the event.
	 * @example
	 * //a callback invoked every eighth note after the first measure
	 * Transport.scheduleRepeat(callback, "8n", "1m");
	 */
	scheduleRepeat(
		callback: TransportCallback,
		interval: Time,
		startTime?: TransportTime | TransportTimeClass,
		duration: Time = Infinity,
	): number {
		const event = new TransportRepeatEvent(this, {
			callback,
			duration : new TimeClass(this.context, duration).toTicks(),
			interval: new TimeClass(this.context, interval).toTicks(),
			time : new TransportTimeClass(this.context, startTime).toTicks(),
		});
		// kick it off if the Transport is started
		// @ts-ignore
		return this._addEvent(event, this._repeatedEvents);
	}

	/**
	 *  Schedule an event that will be removed after it is invoked.
	 *  @param callback The callback to invoke once.
	 *  @param time The time the callback should be invoked.
	 *  @returns The ID of the scheduled event.
	 */
	scheduleOnce(callback: TransportCallback, time: TransportTime | TransportTimeClass): number {
		const event = new TransportEvent(this, {
			callback,
			once : true,
			time : new TransportTimeClass(this.context, time).toTicks(),
		});
		return this._addEvent(event, this._timeline);
	}

	/**
	 * Clear the passed in event id from the timeline
	 * @param eventId The id of the event.
	 */
	clear(eventId: number): this {
		if (this._scheduledEvents.hasOwnProperty(eventId)) {
			const item = this._scheduledEvents[eventId.toString()];
			item.timeline.remove(item.event);
			item.event.dispose();
			delete this._scheduledEvents[eventId.toString()];
		}
		return this;
	}

	/**
	 * Add an event to the correct timeline. Keep track of the
	 * timeline it was added to.
	 * @returns the event id which was just added
	 */
	private _addEvent(event: TransportEvent, timeline: Timeline<TransportEvent>): number {
		this._scheduledEvents[event.id.toString()] = {
			event,
			timeline,
		};
		timeline.add(event);
		return event.id;
	}

	/**
	 * Remove scheduled events from the timeline after
	 * the given time. Repeated events will be removed
	 * if their startTime is after the given time
	 * @param after Clear all events after this time.
	 */
	cancel(after: TransportTime = 0): this {
		const computedAfter = this.toTicks(after);
		this._timeline.forEachFrom(computedAfter, event => this.clear(event.id));
		this._repeatedEvents.forEachFrom(computedAfter, event => this.clear(event.id));
		return this;
	}

	///////////////////////////////////////////////////////////////////////////////
	// 	START/STOP/PAUSE
	///////////////////////////////////////////////////////////////////////////////

	/**
	 *  Bind start/stop/pause events from the clock and emit them.
	 */
	private _bindClockEvents(): void {
		this._clock.on("start", (time, offset) => {
			offset = new TicksClass(this.context, offset).toSeconds();
			this.emit("start", time, offset);
		});

		this._clock.on("stop", (time) => {
			this.emit("stop", time);
		});

		this._clock.on("pause", (time) => {
			this.emit("pause", time);
		});
	}

	/**
	 *  Returns the playback state of the source, either "started", "stopped", or "paused"
	 */
	get state(): PlaybackState {
		return this._clock.getStateAtTime(this.now());
	}

	/**
	 * Start the transport and all sources synced to the transport.
	 * @param  time The time when the transport should start.
	 * @param  offset The timeline offset to start the transport.
	 * @example
	 * //start the transport in one second starting at beginning of the 5th measure.
	 * Transport.start("+1", "4:0:0");
	 */
	start(time?: Time, offset?: TransportTime): this {
		let offsetTicks;
		if (isDefined(offset)) {
			offsetTicks = this.toTicks(offset);
		}
		// start the clock
		this._clock.start(time, offsetTicks);
		return this;
	}

	/**
	 * Stop the transport and all sources synced to the transport.
	 * @param time The time when the transport should stop.
	 * @example
	 * Transport.stop();
	 */
	stop(time?: Time): this {
		this._clock.stop(time);
		return this;
	}

	/**
	 * Pause the transport and all sources synced to the transport.
	 */
	pause(time?: Time): this {
		this._clock.pause(time);
		return this;
	}

	/**
	 * Toggle the current state of the transport. If it is
	 * started, it will stop it, otherwise it will start the Transport.
	 * @param  time The time of the event
	 */
	toggle(time?: Time): this {
		time = this.toSeconds(time);
		if (this._clock.getStateAtTime(time) !== "started") {
			this.start(time);
		} else {
			this.stop(time);
		}
		return this;
	}

	///////////////////////////////////////////////////////////////////////////////
	// 	SETTERS/GETTERS
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * The time signature as just the numerator over 4.
	 * For example 4/4 would be just 4 and 6/8 would be 3.
	 * @example
	 * //common time
	 * Transport.timeSignature = 4;
	 * // 7/8
	 * Transport.timeSignature = [7, 8];
	 * //this will be reduced to a single number
	 * Transport.timeSignature; //returns 3.5
	 */
	get timeSignature(): TimeSignature {
		return this._timeSignature;
	}
	set timeSignature(timeSig: TimeSignature) {
		if (isArray(timeSig)) {
			timeSig = (timeSig[0] / timeSig[1]) * 4;
		}
		this._timeSignature = timeSig;
	}

	/**
	 * When the Transport.loop = true, this is the starting position of the loop.
	 */
	get loopStart(): Time {
		return Time(this._loopStart, "i").toSeconds();
	}
	set loopStart(startPosition: Time) {
		this._loopStart = this.toTicks(startPosition);
	}

	/**
	 * When the Transport.loop = true, this is the ending position of the loop.
	 */
	get loopEnd(): Time {
		return Time(this._loopEnd, "i").toSeconds();
	}
	set loopEnd(endPosition: Time) {
		this._loopEnd = this.toTicks(endPosition);
	}

	/**
	 * Set the loop start and stop at the same time.
	 * @example
	 * //loop over the first measure
	 * Transport.setLoopPoints(0, "1m");
	 * Transport.loop = true;
	 */
	setLoopPoints(startPosition: TransportTime, endPosition: TransportTime): this {
		this.loopStart = startPosition;
		this.loopEnd = endPosition;
		return this;
	}

	/**
	 * The swing value. Between 0-1 where 1 equal to the note + half the subdivision.
	 */
	get swing(): NormalRange {
		return this._swingAmount;
	}
	set swing(amount: NormalRange) {
		// scale the values to a normal range
		this._swingAmount = amount;
	}

	/**
	 * Set the subdivision which the swing will be applied to.
	 * The default value is an 8th note. Value must be less
	 * than a quarter note.
	 */
	get swingSubdivision(): Subdivision {
		return new TicksClass(this.context, this._swingTicks).toNotation();
	}
	set swingSubdivision(subdivision: Subdivision) {
		this._swingTicks = this.toTicks(subdivision);
	}

	/**
	 *  The Transport's position in Bars:Beats:Sixteenths.
	 *  Setting the value will jump to that position right away.
	 */
	get position(): BarsBeatsSixteenths | Time {
		const now = this.now();
		const ticks = this._clock.getTicksAtTime(now);
		return new TicksClass(this.context, ticks).toBarsBeatsSixteenths();
	}
	set position(progress: Time) {
		const ticks = this.toTicks(progress);
		this.ticks = ticks;
	}

	/**
	 *  The Transport's position in seconds
	 *  Setting the value will jump to that position right away.
	 */
	get seconds(): Seconds {
		return this._clock.seconds;
	}

	set seconds(s: Seconds) {
		const now = this.now();
		const ticks = this._clock.frequency.timeToTicks(s, now);
		this.ticks = ticks;
	}

	/**
	 *  The Transport's loop position as a normalized value. Always
	 *  returns 0 if the transport if loop is not true.
	 */
	get progress(): NormalRange {
		if (this.loop) {
			const now = this.now();
			const ticks = this._clock.getTicksAtTime(now);
			return (ticks - this._loopStart) / (this._loopEnd - this._loopStart);
		} else {
			return 0;
		}
	}

	/**
	 *  The transports current tick position.
	 */
	get ticks(): Ticks {
		return this._clock.ticks;
	}
	set ticks(t: Ticks) {
		if (this._clock.ticks !== t) {
			const now = this.now();
			// stop everything synced to the transport
			if (this.state === "started") {
				this.emit("stop", now);
				this._clock.setTicksAtTime(t, now);
				// restart it with the new time
				this.emit("start", now, this.seconds);
			} else {
				this._clock.setTicksAtTime(t, now);
			}
		}
	}

	/**
	 * Get the clock's ticks at the given time.
	 * @param  time  When to get the tick value
	 * @return The tick value at the given time.
	 */
	getTicksAtTime(time: Time): Ticks {
		return Math.round(this._clock.getTicksAtTime(time));
	}

	/**
	 *  Return the elapsed seconds at the given time.
	 *  @param  time  When to get the elapsed seconds
	 *  @return  The number of elapsed seconds
	 */
	getSecondsAtTime(time: Time): Seconds {
		return this._clock.getSecondsAtTime(time);
	}

	/**
	 *  Pulses Per Quarter note. This is the smallest resolution
	 *  the Transport timing supports. This should be set once
	 *  on initialization and not set again. Changing this value
	 *  after other objects have been created can cause problems.
	 */
	get PPQ(): number {
		return this._clock.frequency.multiplier;
	}
	set PPQ(ppq: number) {
		this._clock.frequency.multiplier = ppq;
	}

	///////////////////////////////////////////////////////////////////////////////
	// 	SYNCING
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Returns the time aligned to the next subdivision
	 * of the Transport. If the Transport is not started,
	 * it will return 0.
	 * Note: this will not work precisely during tempo ramps.
	 * @param  subdivision  The subdivision to quantize to
	 * @return  The context time of the next subdivision.
	 * @example
	 * Transport.start(); //the transport must be started
	 * Transport.nextSubdivision("4n");
	 */
	nextSubdivision(subdivision?: Time): Seconds {
		subdivision = this.toTicks(subdivision);
		if (this.state !== "started") {
			// if the transport's not started, return 0
			return 0;
		} else {
			const now = this.now();
			// the remainder of the current ticks and the subdivision
			const transportPos = this.getTicksAtTime(now);
			const remainingTicks = subdivision - transportPos % subdivision;
			return this._clock.nextTickTime(remainingTicks, now);
		}
	}

	/**
	 *  Attaches the signal to the tempo control signal so that
	 *  any changes in the tempo will change the signal in the same
	 *  ratio.
	 *
	 *  @param signal
	 *  @param ratio Optionally pass in the ratio between the two signals.
	 * 				Otherwise it will be computed based on their current values.
	 */
	syncSignal(signal: Signal<any>, ratio?: number): this {
		if (!ratio) {
			// get the sync ratio
			const now = this.now();
			if (signal.getValueAtTime(now) !== 0) {
				const bpm = this.bpm.getValueAtTime(now);
				const computedFreq = 1 / (60 / bpm / this.PPQ);
				ratio = signal.getValueAtTime(now) / computedFreq;
			} else {
				ratio = 0;
			}
		}
		const ratioSignal = new Gain(ratio);
		// @ts-ignore
		this.bpm.connect(ratioSignal);
		// @ts-ignore
		ratioSignal.connect(signal._param);
		this._syncedSignals.push({
			initial : signal.value,
			ratio : ratioSignal,
			signal,
		});
		signal.value = 0;
		return this;
	}

	/**
	 *  Unsyncs a previously synced signal from the transport's control.
	 *  See Transport.syncSignal.
	 */
	unsyncSignal(signal: Signal<any>): this {
		for (let i = this._syncedSignals.length - 1; i >= 0; i--) {
			const syncedSignal = this._syncedSignals[i];
			if (syncedSignal.signal === signal) {
				syncedSignal.ratio.dispose();
				syncedSignal.signal.value = syncedSignal.initial;
				this._syncedSignals.splice(i, 1);
			}
		}
		return this;
	}

	/**
	 *  Clean up.
	 */
	dispose(): this {
		super.dispose();
		this._clock.dispose();
		writable(this, "bpm");
		this._timeline.dispose();
		this._repeatedEvents.dispose();
		return this;
	}

	///////////////////////////////////////////////////////////////////////
	// EMITTER MIXIN TO SATISFY COMPILER
	///////////////////////////////////////////////////////////////////////

	on!: (event: TransportEventNames, callback: (...args: any[]) => void) => this;
	once!: (event: TransportEventNames, callback: (...args: any[]) => void) => this;
	off!: (event: TransportEventNames, callback?: ((...args: any[]) => void) | undefined) => this;
	emit!: (event: any, ...args: any[]) => this;
}

Emitter.mixin(Transport);

///////////////////////////////////////////////////////////////////////////////
// 	INITIALIZATION
///////////////////////////////////////////////////////////////////////////////

onContextInit(context => {
	context.transport = new Transport({ context });
});

onContextClose(context => {
	context.transport.dispose();
});
