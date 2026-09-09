import * as Keychain from 'react-native-keychain';
import { createIdentity, restoreIdentity, systemRandom, toBase64, fromBase64, type LocalIdentity } from '@airlink/core';

/**
 * The long-term identity key, and where it lives.
 *
 * This key IS the user's identity: two devices that have paired once recognise
 * each other forever afterwards because of it, with no server involved. Losing
 * it means every friend has to re-pair; leaking it means someone can impersonate
 * the user to their friends. So it goes in the platform keystore - Keychain on
 * iOS, Keystore-backed storage on Android - and never in the database, never in
 * AsyncStorage, and never in a log line.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` is deliberate: the key must not travel to a
 * new device in an iCloud backup, because an identity that exists in two places
 * is no longer an identity.
 */
const SERVICE = 'com.airlink.identity';
const ACCOUNT = 'identity-v1';

interface StoredIdentity {
  readonly v: 1;
  readonly secretKey: string;
  readonly deviceId: string;
  readonly createdAt: number;
}

export async function loadIdentity(): Promise<LocalIdentity | null> {
  try {
    const credentials = await Keychain.getGenericPassword({ service: SERVICE });
    if (!credentials || credentials.username !== ACCOUNT) return null;
    const stored = JSON.parse(credentials.password) as StoredIdentity;
    if (stored.v !== 1) return null;
    return restoreIdentity(fromBase64(stored.secretKey), stored.deviceId, stored.createdAt);
  } catch {
    // A keystore that cannot be read is indistinguishable from an empty one,
    // and treating it as empty produces a new identity rather than a crash on
    // first launch.
    return null;
  }
}

export async function createAndStoreIdentity(now: number): Promise<LocalIdentity> {
  const identity = createIdentity(systemRandom, now);
  const stored: StoredIdentity = {
    v: 1,
    secretKey: toBase64(identity.signing.secretKey),
    deviceId: identity.deviceId,
    createdAt: identity.createdAt,
  };
  await Keychain.setGenericPassword(ACCOUNT, JSON.stringify(stored), {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return identity;
}

/** Wipes the identity. Every friend will have to pair again - confirm first. */
export async function destroyIdentity(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE });
}
