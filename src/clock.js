// The game clock. Instead of (Date.now() - startEpoch), we anchor on
// resource.playbackDuration — the exact amount of audio the bot has dispatched
// to Discord. If the encoder hiccups or packets stall, playbackDuration stalls
// with them, so the clock self-corrects drift over long songs.
//
// A press's song position:
//   posAtHit = playbackDuration(now) - (now - hitEpoch)
//
// hitEpoch comes from the snowflake (Discord's clock), `now` from ours; the
// constant skew between the two clocks is absorbed by calibration because
// calibration measures through this exact same formula.

import { snowflakeToMs } from "./snowflake.js";

export class SongClock {
  constructor() {
    this.resource = null;
  }

  attach(resource) {
    this.resource = resource;
  }

  get started() {
    return this.resource !== null && this.resource.playbackDuration > 0;
  }

  // current song position in ms
  now() {
    return this.resource ? this.resource.playbackDuration : 0;
  }

  // song position at a given wall-clock moment (ms epoch)
  atEpoch(epochMs) {
    return this.now() - (Date.now() - epochMs);
  }

  // song position at the moment Discord received the input
  atSnowflake(id) {
    return this.atEpoch(snowflakeToMs(id));
  }
}
