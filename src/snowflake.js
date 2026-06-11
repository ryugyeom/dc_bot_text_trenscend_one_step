// Every Discord ID is a snowflake: bits 22+ hold the moment Discord's server
// minted it, in ms. For a button press, interaction.id is created the instant
// Discord receives the click — before it ever reaches this bot. That makes it
// a server-side hit timestamp that is immune to bot processing/network lag.

const DISCORD_EPOCH = 1420070400000n;

export function snowflakeToMs(id) {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

export function msToSnowflake(ms) {
  return ((BigInt(ms) - DISCORD_EPOCH) << 22n).toString();
}
