// Shared HTTP header names that carry contract-level meaning across the desktop
// client and the server. Keep them here so both sides agree on the exact wire
// name.

// The client's own wall-clock instant at the moment a request left the device.
// Paired with the server's authoritative receive time, it yields a device clock
// offset sample (a fact); the corrected time is derived later in the read model
// and never overwrites the stored client timestamps.
export const CLIENT_SENT_AT_HEADER = 'x-recapsy-client-sent-at';
