import { errorCodes, isErrorWithCode, keepLocalCopy, pick } from '@react-native-documents/picker';
import { launchImageLibrary } from 'react-native-image-picker';
import { isSafeFilename } from '@airlink/core';
import { measureFile, pathFromUri } from './fileStore.js';
import { shareStrings } from './strings.js';

/**
 * Choosing something to send.
 *
 * Both pickers hand back a URI that this app may not be able to read directly -
 * on Android a document is a `content://` handle owned by another app, and on
 * iOS a picked document lives behind a security-scoped bookmark. Both are
 * copied into this app's own storage first, because the transfer has to be able
 * to re-read the file minutes later, possibly after a reconnect, long after the
 * picker's grant has lapsed.
 */

export interface PickedFile {
  /** A real path inside this app's sandbox. Readable for as long as we need. */
  readonly path: string;
  /** What the user sees, and the name that travels to the peer. */
  readonly filename: string;
  readonly mimeType: string;
  readonly fileBytes: number;
  /** Set for photos and video, so Compose can show what is about to be sent. */
  readonly previewUri: string | null;
}

export type PickResult =
  | { readonly status: 'picked'; readonly file: PickedFile }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly message: string };

const EXTENSION_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  pdf: 'application/pdf',
  txt: 'text/plain',
  zip: 'application/zip',
};

function mimeFor(filename: string, declared: string | null | undefined): string {
  if (declared && declared.length > 0) return declared;
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return EXTENSION_MIME[filename.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * A name the protocol will accept.
 *
 * `isSafeFilename` is the same check the receiving side applies, so running it
 * here means a picked file is rejected while the user is still looking at the
 * picker rather than after they have pressed Send.
 */
function usableName(candidate: string | null | undefined, fallbackExtension: string): string {
  const trimmed = (candidate ?? '').trim();
  if (trimmed.length > 0 && isSafeFilename(trimmed)) return trimmed;
  return `shared-${Date.now()}${fallbackExtension}`;
}

/** A photo or a video from the library. */
export async function pickPhoto(): Promise<PickResult> {
  const response = await launchImageLibrary({ mediaType: 'mixed', selectionLimit: 1 });
  if (response.didCancel) return { status: 'cancelled' };
  if (response.errorCode) return { status: 'failed', message: shareStrings.couldNotReadFile };

  const asset = response.assets?.[0];
  if (!asset?.uri) return { status: 'failed', message: shareStrings.couldNotReadFile };

  const declaredType = asset.type ?? null;
  const filename = usableName(asset.fileName, declaredType?.startsWith('video/') ? '.mp4' : '.jpg');
  const path = pathFromUri(asset.uri);
  try {
    const fileBytes = asset.fileSize ?? (await measureFile(path));
    return {
      status: 'picked',
      file: {
        path,
        filename,
        mimeType: mimeFor(filename, declaredType),
        fileBytes,
        previewUri: asset.uri,
      },
    };
  } catch {
    return { status: 'failed', message: shareStrings.couldNotReadFile };
  }
}

/** Any file, via the system document picker. */
export async function pickDocument(): Promise<PickResult> {
  let picked;
  try {
    const results = await pick({ mode: 'import', allowMultiSelection: false });
    picked = results[0];
  } catch (err) {
    if (isErrorWithCode(err) && err.code === errorCodes.OPERATION_CANCELED) return { status: 'cancelled' };
    return { status: 'failed', message: shareStrings.couldNotReadFile };
  }
  if (!picked) return { status: 'cancelled' };

  const filename = usableName(picked.name, '');
  // The copy is what makes the file ours: a content:// grant does not outlive
  // the picker, and a transfer may still be reading an hour later.
  const [copy] = await keepLocalCopy({
    files: [{ uri: picked.uri, fileName: filename }],
    destination: 'cachesDirectory',
  });
  if (!copy || copy.status !== 'success') return { status: 'failed', message: shareStrings.couldNotReadFile };

  const path = pathFromUri(copy.localUri);
  try {
    const fileBytes = picked.size ?? (await measureFile(path));
    const mimeType = mimeFor(filename, picked.type);
    return {
      status: 'picked',
      file: {
        path,
        filename,
        mimeType,
        fileBytes,
        previewUri: mimeType.startsWith('image/') ? copy.localUri : null,
      },
    };
  } catch {
    return { status: 'failed', message: shareStrings.couldNotReadFile };
  }
}
