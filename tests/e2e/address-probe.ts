import { Buffer } from 'buffer';

export async function probeAddresses() {
  const {
    BLSScalar, DustAddress, MidnightBech32m, ShieldedAddress,
    ShieldedCoinPublicKey, ShieldedEncryptionPublicKey, UnshieldedAddress,
  } = await import('@midnightntwrk/wallet-sdk-address-format');
  const network = 'preview';
  // Public dummy values only: no seed, key derivation, wallet or provider.
  // Cover every SCALE compact width, including a full-size DUST public value.
  const dustValues = [0n, 63n, 64n, 16383n, 16384n, (1n << 30n) - 1n,
    1n << 30n, (1n << 128n) + 17n, BLSScalar.modulus - 1n];
  const dust = dustValues.map(value => {
    const address = new DustAddress(value);
    // Same codec.encode call used by the packaged SDK's address$ mapper.
    const encoded = DustAddress.codec.encode(network, address).asString();
    const parsed = MidnightBech32m.parse(encoded);
    return encoded.startsWith('mn_dust_preview1') &&
      DustAddress.codec.decode(network, parsed).equals(value);
  });
  const shielded = new ShieldedAddress(
    new ShieldedCoinPublicKey(Buffer.alloc(32, 0x11)),
    new ShieldedEncryptionPublicKey(Buffer.alloc(32, 0x22)),
  );
  const shieldedEncoded = ShieldedAddress.codec.encode(network, shielded);
  const shieldedText = shieldedEncoded.asString();
  // Exercise the string parser used by SDK transfer/connector normalization.
  const shieldedParsed = MidnightBech32m.parse(shieldedText);
  const shieldedDecoded = ShieldedAddress.codec.decode(network, shieldedParsed);
  const invalidShieldedChecksum = shieldedText.slice(0, -1) +
    (shieldedText.endsWith('q') ? 'p' : 'q');
  const unshielded = new UnshieldedAddress(Buffer.alloc(32, 0x33));
  const unshieldedText = UnshieldedAddress.codec.encode(network, unshielded).asString();
  const rejects = (action: () => unknown, message: RegExp) => {
    try { action(); return false; }
    catch (error) { return error instanceof Error && message.test(error.message); }
  };
  let negativeDustRejected = false;
  try { DustAddress.codec.encode(network, new DustAddress(-1n)); }
  catch (error) {
    // A missing callable (or another unrelated exception) is NOT a pass.
    negativeDustRejected = error instanceof Error && error.name === 'AssertionError' &&
      'code' in error && error.code === 'ERR_ASSERTION' && error.message === 'invalid compact';
  }
  return {
    dust,
    dust64ScaleHex: new DustAddress(64n).serialize().toString('hex'),
    shielded: shieldedText.startsWith('mn_shield-addr_preview1') &&
      ShieldedAddress.codec.decode(network, shieldedEncoded).equals(shielded),
    shieldedTextLength: shieldedText.length,
    shieldedStringRoundtrip: shieldedDecoded.equals(shielded) &&
      ShieldedAddress.codec.encode(network, shieldedDecoded).asString() === shieldedText,
    invalidShieldedChecksumRejected: rejects(() => MidnightBech32m.parse(invalidShieldedChecksum),
      /Invalid checksum/),
    invalidShieldedPayloadRejected: rejects(() => ShieldedAddress.codec.decode(network,
      MidnightBech32m.parse(new MidnightBech32m('shield-addr', network, Buffer.alloc(31)).asString())),
      /Coin public key needs to be 32 bytes long/),
    wrongShieldedNetworkRejected: rejects(() => ShieldedAddress.codec.decode('preprod',
      MidnightBech32m.parse(shieldedText)), /Expected preprod address, got preview/),
    wrongShieldedTypeRejected: rejects(() => ShieldedAddress.codec.decode(network,
      MidnightBech32m.parse(unshieldedText)), /Expected type shield-addr, got addr/),
    unshielded: unshieldedText.startsWith('mn_addr_preview1') &&
      UnshieldedAddress.codec.decode(network, MidnightBech32m.parse(unshieldedText)).equals(unshielded),
    negativeDustRejected,
    oversizedDustRejected: rejects(() => new DustAddress(BLSScalar.modulus), /Dust address is too large/),
    invalidUnshieldedRejected: rejects(() => new UnshieldedAddress(Buffer.alloc(31)), /32 bytes/),
    wrongNetworkRejected: rejects(() => UnshieldedAddress.codec.decode('preprod',
      MidnightBech32m.parse(unshieldedText)), /Expected preprod address, got preview/),
    invalidDustPayloadRejected: rejects(() => DustAddress.codec.decode(network,
      new MidnightBech32m('dust', network, Buffer.from([0, 0]))), /Unprocessed data/),
  };
}
