/**
 * A photo sent in a conversation accepts itself on the other phone.
 *
 * THE BUG THIS EXISTS FOR, found by sending a real photo between two
 * simulators. The Share tab asks before receiving a file, which is right for
 * something a stranger pushes at you. Applied to a photo in a chat it is wrong,
 * and it failed silently in the worst way: the receiver wrote the message row
 * and the file row from the chat announcement, then waited for somebody to
 * press Accept on a screen they were not looking at. Nobody did. The sender's
 * transfer expired with "They never answered", the sender's bubble went red,
 * and the receiver's bubble sat there as an empty grey chip for ever.
 *
 * Both halves of the database agreed that a photo existed. Neither had the
 * bytes. That is why this is tested at the transfer layer rather than through
 * the screen: the screen looked fine.
 *
 * The offer and the chat message announcing it race over two different
 * channels, so BOTH ORDERS have to work, and both are asserted below.
 */
import { TransferDirection, TransferState } from '@airlink/core';
import { TransferCenter } from '../src/screens/share/transferCenter.js';
import { AirLinkClient } from '../src/client/AirLinkClient.js';

const TRANSFER_ID = 'tr_photo_1';

async function bootClient(): Promise<AirLinkClient> {
  const client = new AirLinkClient({ appVersion: '1.0.0', platform: 'ios', deviceModel: 'test' });
  await client.load();
  await client.createProfile('Maria', null);
  return client;
}

/**
 * Reach into the centre the way the two real callers do, without a live
 * session: `onOffer` is what the protocol calls when bytes are offered, and
 * `expect` is what the chat centre calls when the conversation announces them.
 */
interface Internals {
  onOffer(peerKey: string, offer: Record<string, unknown>): Promise<void>;
  accept(transferId: string): Promise<void>;
  expect(transferId: string): void;
  get(transferId: string): { state: string; direction: string } | undefined;
}

function internals(centre: TransferCenter): Internals {
  return centre as unknown as Internals;
}

function offerOf(transferId: string): Record<string, unknown> {
  return {
    transferId,
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    fileBytes: 265_115,
    chunkSize: 4_096,
    contentHash: new Uint8Array(32),
  };
}

afterEach(() => {
  globalThis.__airlinkNativeTest?.clearCalls();
  globalThis.__airlinkSqliteTest?.clear();
  globalThis.__airlinkKeychainTest?.clear();
});

test('an offer nobody vouched for waits to be answered by hand', async () => {
  const client = await bootClient();
  const centre = new TransferCenter(client);
  const api = internals(centre);
  const accepted: string[] = [];
  api.accept = async (id) => void accepted.push(id);

  await api.onOffer('peer-1', offerOf(TRANSFER_ID));

  // This is the Share tab's behaviour and it must not change: a file pushed at
  // you out of nowhere still gets a question.
  expect(accepted).toEqual([]);
});

test('an offer the conversation announced FIRST is accepted when it arrives', async () => {
  const client = await bootClient();
  const centre = new TransferCenter(client);
  const api = internals(centre);
  const accepted: string[] = [];
  api.accept = async (id) => void accepted.push(id);

  // The chat message wins the race.
  api.expect(TRANSFER_ID);
  await api.onOffer('peer-1', offerOf(TRANSFER_ID));

  expect(accepted).toEqual([TRANSFER_ID]);
});

test('an offer that arrives FIRST is accepted when the conversation announces it', async () => {
  const client = await bootClient();
  const centre = new TransferCenter(client);
  const api = internals(centre);
  const accepted: string[] = [];
  api.accept = async (id) => void accepted.push(id);

  // The offer wins the race. It sits unanswered...
  await api.onOffer('peer-1', offerOf(TRANSFER_ID));
  expect(accepted).toEqual([]);

  // ...until the chat message catches up.
  api.expect(TRANSFER_ID);

  expect(accepted).toEqual([TRANSFER_ID]);
});

test('vouching is spent once, so an unrelated later offer still asks', async () => {
  const client = await bootClient();
  const centre = new TransferCenter(client);
  const api = internals(centre);
  const accepted: string[] = [];
  api.accept = async (id) => void accepted.push(id);

  api.expect(TRANSFER_ID);
  await api.onOffer('peer-1', offerOf(TRANSFER_ID));
  expect(accepted).toEqual([TRANSFER_ID]);

  // A second offer reusing the same id is not something the conversation asked
  // for a second time. Re-accepting it would let a peer replay an id to push
  // bytes without a question.
  await api.onOffer('peer-1', offerOf(TRANSFER_ID));

  expect(accepted).toEqual([TRANSFER_ID]);
});

test('the memory of vouched-for files is bounded', async () => {
  const client = await bootClient();
  const centre = new TransferCenter(client);
  const api = internals(centre);
  const accepted: string[] = [];
  api.accept = async (id) => void accepted.push(id);

  // A conversation can name files that never arrive - a peer that walks away
  // mid-send, a retry that mints a new id. That must not grow for ever.
  for (let i = 0; i < 500; i++) api.expect(`ghost_${i}`);

  // The most recent one still works, which is what matters to a user.
  await api.onOffer('peer-1', offerOf('ghost_499'));
  expect(accepted).toEqual(['ghost_499']);

  const expected = (centre as unknown as { expected: Set<string> }).expected;
  expect(expected.size).toBeLessThanOrEqual(64);
});

test('the incoming record is written before anything is accepted', async () => {
  const client = await bootClient();
  const centre = new TransferCenter(client);
  const api = internals(centre);
  api.accept = async () => undefined;

  api.expect(TRANSFER_ID);
  await api.onOffer('peer-1', offerOf(TRANSFER_ID));

  // The row has to exist even while the bytes are still moving, or the bubble
  // has nothing to draw itself with.
  const record = api.get(TRANSFER_ID);
  expect(record).toBeDefined();
  expect(record?.direction).toBe(TransferDirection.INCOMING);
});

test('an accept that throws does not take the offer down with it', async () => {
  const client = await bootClient();
  const centre = new TransferCenter(client);
  const api = internals(centre);
  api.accept = async () => {
    throw new Error('the offer expired between arriving and being accepted');
  };

  api.expect(TRANSFER_ID);
  await expect(api.onOffer('peer-1', offerOf(TRANSFER_ID))).resolves.toBeUndefined();

  // Still there, still answerable by hand.
  expect(api.get(TRANSFER_ID)?.state).toBe(TransferState.OFFERED);
});
