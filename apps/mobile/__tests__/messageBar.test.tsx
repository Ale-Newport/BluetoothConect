/**
 * The message bar: where each control is, and what each one does.
 *
 * The arrangement is the one people already know from every messenger - a plus
 * on the left, the text box, then the camera and the microphone, which become
 * Send the moment there is something to send. Those are not decoration; each is
 * a promise a person acts on without looking, so the tests pin which controls
 * exist in each state, and that every one of them reaches the code that does
 * the work. The work itself (what a photo or a file becomes in the database and
 * on the wire) is `attachments.test.tsx`.
 */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { strings } from '@airlink/config';
import { ThemeProvider } from '../src/ui/index.js';
import { Composer } from '../src/screens/chat/Composer.js';
import { chatCopy } from '../src/screens/chat/chatStrings.js';
import { noticeDuration } from '../src/screens/chat/chatTime.js';
import type { OutgoingAttachment } from '../src/screens/chat/attachments.js';

/** The sheet is a Modal, and Jest's stand-in never says when a modal has left; this one lets a test say it. */
let mockModalDismissed: (() => void) | undefined;
jest.mock('react-native/Libraries/Modal/Modal', () => ({
  __esModule: true,
  default: (props: { visible?: boolean; onDismiss?: () => void; children?: React.ReactNode }): React.ReactNode => {
    mockModalDismissed = props.onDismiss;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { View } = require('react-native');
    return props.visible ? <View>{props.children}</View> : null;
  },
}));

let mockLibraryCalls = 0;
let mockCameraCalls = 0;
let mockDocumentCalls = 0;
let mockPickerResponse: { didCancel?: boolean; errorCode?: string; assets?: Record<string, unknown>[] } = {
  didCancel: true,
};

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: async () => {
    mockLibraryCalls += 1;
    return mockPickerResponse;
  },
  launchCamera: async () => {
    mockCameraCalls += 1;
    return mockPickerResponse;
  },
}));

jest.mock('../src/screens/share/picker.js', () => ({
  pickDocument: async () => {
    mockDocumentCalls += 1;
    return {
      status: 'picked',
      file: {
        path: '/tmp/airlink-test/menu.pdf',
        filename: 'menu.pdf',
        mimeType: 'application/pdf',
        fileBytes: 52_000,
        previewUri: null,
      },
    };
  },
}));

const A_PHOTO = {
  assets: [
    {
      uri: 'file:///tmp/airlink-test/photo.jpg',
      fileName: 'photo.jpg',
      type: 'image/jpeg',
      fileSize: 240_000,
      width: 1280,
      height: 960,
    },
  ],
};

beforeEach(() => {
  mockLibraryCalls = 0;
  mockCameraCalls = 0;
  mockDocumentCalls = 0;
  mockPickerResponse = { didCancel: true };
});

async function bar(value: string): Promise<{
  view: Awaited<ReturnType<typeof render>>;
  onSend: jest.Mock;
  onAttach: jest.Mock<void, [OutgoingAttachment]>;
  onNotice: jest.Mock;
}> {
  const onSend = jest.fn();
  const onAttach = jest.fn<void, [OutgoingAttachment]>();
  const onNotice = jest.fn();
  const view = await render(
    <ThemeProvider>
      <Composer
        value={value}
        onChangeText={() => undefined}
        onSend={onSend}
        onAttach={onAttach}
        onNotice={onNotice}
        replyTo={null}
        peerName="Mallory"
        onCancelReply={() => undefined}
      />
    </ThemeProvider>,
  );
  return { view, onSend, onAttach, onNotice };
}

/** The moment iOS says the sheet has finished leaving, which is when a picker may start. */
async function sheetHasLeft(): Promise<void> {
  await act(async () => {
    mockModalDismissed?.();
  });
}

test('with nothing typed the bar is plus, text box, camera, microphone - and no Send', async () => {
  const { view } = await bar('');
  expect(view.getByLabelText(chatCopy.attachLabel)).toBeTruthy();
  expect(view.getByLabelText(chatCopy.composerLabel)).toBeTruthy();
  expect(view.getByLabelText(chatCopy.cameraLabel)).toBeTruthy();
  expect(view.getByLabelText(chatCopy.recordLabel)).toBeTruthy();
  expect(view.queryByLabelText(chatCopy.sendLabel)).toBeNull();
});

test('typing replaces the camera and the microphone with Send, and keeps the plus', async () => {
  const { view, onSend } = await bar('hello');
  expect(view.getByLabelText(chatCopy.sendLabel)).toBeTruthy();
  expect(view.queryByLabelText(chatCopy.cameraLabel)).toBeNull();
  expect(view.queryByLabelText(chatCopy.recordLabel)).toBeNull();
  expect(view.getByLabelText(chatCopy.attachLabel)).toBeTruthy();

  await fireEvent.press(view.getByLabelText(chatCopy.sendLabel));
  expect(onSend).toHaveBeenCalledTimes(1);
});

test('a box of only spaces is still empty: the camera and microphone stay, and nothing can be sent', async () => {
  const { view } = await bar('   ');
  expect(view.queryByLabelText(chatCopy.sendLabel)).toBeNull();
  expect(view.getByLabelText(chatCopy.recordLabel)).toBeTruthy();
});

test('the camera button opens the camera and hands the photo up', async () => {
  mockPickerResponse = A_PHOTO;
  const { view, onAttach } = await bar('');

  await act(async () => {
    await fireEvent.press(view.getByLabelText(chatCopy.cameraLabel));
  });

  expect(mockCameraCalls).toBe(1);
  expect(mockLibraryCalls).toBe(0);
  expect(onAttach).toHaveBeenCalledTimes(1);
  expect(onAttach.mock.calls[0]?.[0]).toMatchObject({ kind: 'image', filename: 'photo.jpg', fileBytes: 240_000 });
});

test('a camera that cannot be used says so, and attaches nothing', async () => {
  mockPickerResponse = { errorCode: 'permission' };
  const { view, onAttach, onNotice } = await bar('');

  await act(async () => {
    await fireEvent.press(view.getByLabelText(chatCopy.cameraLabel));
  });

  expect(onNotice).toHaveBeenCalledWith(chatCopy.cameraDenied);
  expect(onAttach).not.toHaveBeenCalled();
});

test('the plus offers a photo and a file, and nothing starts until one is chosen', async () => {
  const { view } = await bar('');
  expect(view.queryByText(chatCopy.attachPhotoRow)).toBeNull();

  await fireEvent.press(view.getByLabelText(chatCopy.attachLabel));

  expect(view.getByLabelText(chatCopy.attachPhotoRow)).toBeTruthy();
  expect(view.getByLabelText(chatCopy.attachFileRow)).toBeTruthy();
  expect(mockLibraryCalls + mockCameraCalls + mockDocumentCalls).toBe(0);
});

test('choosing Photo library starts the library only after the sheet has left', async () => {
  mockPickerResponse = A_PHOTO;
  const { view, onAttach } = await bar('');

  await fireEvent.press(view.getByLabelText(chatCopy.attachLabel));
  await fireEvent.press(view.getByLabelText(chatCopy.attachPhotoRow));

  // Presenting a system picker while the modal is still leaving is how iOS
  // ends up with a button that does nothing.
  expect(mockLibraryCalls).toBe(0);
  await sheetHasLeft();

  expect(mockLibraryCalls).toBe(1);
  expect(mockDocumentCalls).toBe(0);
  expect(onAttach.mock.calls[0]?.[0]).toMatchObject({ kind: 'image' });
});

test('choosing File opens the Files app and attaches what comes back', async () => {
  const { view, onAttach } = await bar('');

  await fireEvent.press(view.getByLabelText(chatCopy.attachLabel));
  await fireEvent.press(view.getByLabelText(chatCopy.attachFileRow));
  await sheetHasLeft();

  expect(mockDocumentCalls).toBe(1);
  expect(mockLibraryCalls).toBe(0);
  expect(onAttach.mock.calls[0]?.[0]).toMatchObject({ kind: 'file', filename: 'menu.pdf', fileBytes: 52_000 });
});

test('closing the sheet without choosing starts nothing, even when it finishes leaving', async () => {
  const { view, onAttach } = await bar('');

  await fireEvent.press(view.getByLabelText(chatCopy.attachLabel));
  await fireEvent.press(view.getByLabelText(strings.common.cancel));
  await sheetHasLeft();

  expect(mockLibraryCalls + mockCameraCalls + mockDocumentCalls).toBe(0);
  expect(onAttach).not.toHaveBeenCalled();
});

test('a choice is started once: a second dismissal does not start it again', async () => {
  mockPickerResponse = A_PHOTO;
  const { view } = await bar('');

  await fireEvent.press(view.getByLabelText(chatCopy.attachLabel));
  await fireEvent.press(view.getByLabelText(chatCopy.attachPhotoRow));
  await sheetHasLeft();
  await sheetHasLeft();

  expect(mockLibraryCalls).toBe(1);
});

/**
 * The camera's refusal is a sentence that ends in an instruction. On screen for
 * the 1.6 seconds "Copied" gets, nobody can read it, so the time a notice stays
 * grows with its length - and stops growing before it becomes a nuisance.
 */
test('a notice stays long enough to read, and not longer than six seconds', () => {
  expect(noticeDuration(chatCopy.copied)).toBe(1600);
  expect(noticeDuration(chatCopy.cameraDenied)).toBeGreaterThan(3000);
  expect(noticeDuration(chatCopy.cameraDenied)).toBeGreaterThan(noticeDuration(chatCopy.copied));
  expect(noticeDuration('x'.repeat(10_000))).toBe(6000);
});
