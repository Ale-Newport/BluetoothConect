import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, type ViewStyle } from 'react-native';
import { Camera, type CameraDevice, type CameraRef } from 'react-native-vision-camera';
import type { Image, RawPixelData } from 'react-native-nitro-image';
import jsQR from 'jsqr';
import { useTheme } from '../../ui/index.js';

/**
 * The camera surface, and the QR decoding behind it.
 *
 * Kept in its own file because everything here talks to a native module, and the
 * screen around it has to keep working - explaining permissions, explaining a
 * missing camera, showing a result - whether or not this ever renders. Mounting
 * it is the LAST thing the screen does, once permission is granted and a real
 * camera exists.
 *
 * WHY IT DECODES IN JAVASCRIPT. Per docs/adr-001-qr-scanning.md: the obvious
 * dependency, react-native-vision-camera-barcode-scanner, is backed by Google ML
 * Kit, which ships x86_64-only simulator slices and forces
 * EXCLUDED_ARCHS = arm64 onto the whole app - making the app impossible to run
 * in a simulator on any Apple Silicon Mac. So the camera is used for the preview
 * only, and the pixels are decoded by jsQR: pure JavaScript, no native code,
 * nothing to exclude an architecture for.
 *
 * WHY NOT VISION CAMERA'S OWN OBJECT OUTPUT, which would be the obvious way to
 * avoid both: `createObjectOutput` is iOS-only in 5.2.3 - the Android factory
 * throws "CameraObjectOutput is not available on Android!" - so building on it
 * would mean a scan screen that red-screens on half the devices we ship to. The
 * snapshot path below is the only one implemented on both platforms.
 *
 * The snapshot comes off the PREVIEW view rather than a photo output: they are
 * the pixels already on screen, so there is no shutter sound, no file written to
 * disk and nothing to clean up afterwards.
 */

/** How often to attempt a decode. Fast enough to feel instant, slow enough to idle. */
const SCAN_INTERVAL_MS = 400;

/**
 * Snapshots are downscaled before decoding.
 *
 * jsQR is O(pixels), and a full-resolution frame would take seconds. A QR code
 * held at arm's length is comfortably resolvable at this width, and the decode
 * then costs a few milliseconds.
 */
const DECODE_WIDTH = 480;

export interface ScannerCameraProps {
  readonly device: CameraDevice;
  /** False while a result is on screen, so scanning cannot re-fire behind a card. */
  readonly isActive: boolean;
  /** Fires once per distinct code. The screen decides what to do with it. */
  readonly onCode: (value: string) => void;
  /** A camera that will never produce a frame. The screen says so rather than spinning. */
  readonly onError: (error: Error) => void;
  readonly style?: ViewStyle;
}

export function ScannerCamera({
  device,
  isActive,
  onCode,
  onError,
  style,
}: ScannerCameraProps): React.JSX.Element {
  const theme = useTheme();
  const camera = useRef<CameraRef>(null);
  const [ready, setReady] = useState(false);
  /**
   * The same code stays in frame for many attempts running. Reporting it once
   * is what stops one friend's QR from pushing a stack of result screens.
   */
  const lastValue = useRef<string | null>(null);
  // One decode at a time: jsQR runs on the JS thread, and stacking attempts
  // behind a slow one is how a scanner turns into a slideshow.
  const busy = useRef(false);

  const attemptDecode = useCallback(async (): Promise<void> => {
    const view = camera.current;
    if (busy.current || !isActive || view === null) return;
    busy.current = true;

    let snapshot: Image | null = null;
    let scaled: Image | null = null;
    try {
      snapshot = await view.takeSnapshot();

      // Downscale natively first, so the pixel copy that crosses into
      // JavaScript is the small one.
      const scale = Math.min(1, DECODE_WIDTH / Math.max(1, snapshot.width));
      if (scale < 1) {
        scaled = await snapshot.resizeAsync(
          Math.max(1, Math.round(snapshot.width * scale)),
          Math.max(1, Math.round(snapshot.height * scale)),
        );
      }

      const raw = await (scaled ?? snapshot).toRawPixelDataAsync();
      const rgba = toRgba(raw);
      if (rgba === null) return;

      const result = jsQR(rgba, raw.width, raw.height, { inversionAttempts: 'dontInvert' });
      const value = result?.data;
      if (typeof value !== 'string' || value.length === 0) return;
      if (value === lastValue.current) return;
      lastValue.current = value;
      onCode(value);
    } catch {
      // A snapshot can fail while the camera is starting, rotating, or being
      // torn down. None of that is worth surfacing - the next attempt is a few
      // hundred milliseconds away, and the screen already tells the user what to
      // do if nothing is ever found.
    } finally {
      // Nitro objects are garbage collected, but a loop allocating two bitmaps
      // every 400 ms is exactly the case where waiting for the collector shows
      // up as memory pressure.
      scaled?.dispose();
      snapshot?.dispose();
      busy.current = false;
    }
  }, [isActive, onCode]);

  useEffect(() => {
    if (!ready || !isActive) return undefined;
    const timer = setInterval(() => void attemptDecode(), SCAN_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [ready, isActive, attemptDecode]);

  // A fresh scanning session may legitimately want to re-read the code it just
  // reported - the user could be pointing at the same phone on purpose.
  useEffect(() => {
    if (isActive) lastValue.current = null;
  }, [isActive]);

  return (
    <View
      style={[
        {
          flex: 1,
          overflow: 'hidden',
          borderRadius: theme.radius.lg,
          backgroundColor: theme.colors.surfaceElevated,
        },
        style,
      ]}
    >
      <Camera
        ref={camera}
        device={device}
        isActive={isActive}
        style={{ flex: 1 }}
        onPreviewStarted={() => setReady(true)}
        onError={onError}
      />
      <Viewfinder />
    </View>
  );
}

/**
 * Raw pixels as jsQR wants them: interleaved RGBA, one byte per channel.
 *
 * The native side hands back whatever the platform's bitmap happens to use -
 * typically BGRA on iOS and RGBA on Android - and Nitro Image is emphatic that
 * the format must be read rather than assumed. For a black-and-white QR the
 * channel order barely matters to the luminance jsQR derives from it, but
 * "barely" is not a contract, and getting it right costs one pass over an
 * already small buffer.
 */
function toRgba(raw: RawPixelData): Uint8ClampedArray | null {
  const pixels = raw.width * raw.height;
  if (pixels <= 0) return null;
  const source = new Uint8Array(raw.buffer);

  // Byte offsets of red, green and blue within each source pixel, and the
  // source pixel stride. Alpha is irrelevant to a decoder that only wants
  // luminance, so it is written back as fully opaque.
  const layouts: Record<string, readonly [number, number, number, number]> = {
    RGBA: [0, 1, 2, 4],
    RGBX: [0, 1, 2, 4],
    BGRA: [2, 1, 0, 4],
    BGRX: [2, 1, 0, 4],
    ARGB: [1, 2, 3, 4],
    XRGB: [1, 2, 3, 4],
    ABGR: [3, 2, 1, 4],
    XBGR: [3, 2, 1, 4],
    RGB: [0, 1, 2, 3],
    BGR: [2, 1, 0, 3],
  };
  const layout = layouts[raw.pixelFormat];
  if (!layout) return null;
  const [rOffset, gOffset, bOffset, stride] = layout;
  if (source.length < pixels * stride) return null;

  const out = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    const from = i * stride;
    const to = i * 4;
    out[to] = source[from + rOffset] as number;
    out[to + 1] = source[from + gOffset] as number;
    out[to + 2] = source[from + bOffset] as number;
    out[to + 3] = 255;
  }
  return out;
}

/**
 * The frame that tells someone where to point.
 *
 * Four corners rather than a full rectangle: it reads as a target without
 * covering the picture, and it is the shape every camera app has trained people
 * to recognise.
 */
function Viewfinder(): React.JSX.Element {
  const theme = useTheme();
  // Three points of stroke: thinner disappears against a busy tray table.
  const thickness = 3;
  const arm = theme.spacing.xxl;
  const base: ViewStyle = {
    position: 'absolute',
    width: arm,
    height: arm,
    borderColor: theme.colors.onAccent,
  };

  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: theme.spacing.xxl,
        bottom: theme.spacing.xxl,
        left: theme.spacing.xxl,
        right: theme.spacing.xxl,
      }}
    >
      <View
        style={[
          base,
          {
            top: 0,
            left: 0,
            borderTopWidth: thickness,
            borderLeftWidth: thickness,
            borderTopLeftRadius: theme.radius.md,
          },
        ]}
      />
      <View
        style={[
          base,
          {
            top: 0,
            right: 0,
            borderTopWidth: thickness,
            borderRightWidth: thickness,
            borderTopRightRadius: theme.radius.md,
          },
        ]}
      />
      <View
        style={[
          base,
          {
            bottom: 0,
            left: 0,
            borderBottomWidth: thickness,
            borderLeftWidth: thickness,
            borderBottomLeftRadius: theme.radius.md,
          },
        ]}
      />
      <View
        style={[
          base,
          {
            bottom: 0,
            right: 0,
            borderBottomWidth: thickness,
            borderRightWidth: thickness,
            borderBottomRightRadius: theme.radius.md,
          },
        ]}
      />
    </View>
  );
}
