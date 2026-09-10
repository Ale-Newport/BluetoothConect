import React, { useCallback, useEffect, useRef } from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import {
  Camera,
  isScannedCode,
  useObjectOutput,
  type CameraDevice,
  type ScannedObject,
  type ScannedObjectType,
} from 'react-native-vision-camera';
import { useTheme } from '../../ui/index.js';

/**
 * The camera surface, and nothing else.
 *
 * Kept in its own file for two reasons. The first is that everything in here
 * talks to a native module, and the screen around it has to keep working -
 * explaining permissions, explaining a missing camera, showing a result -
 * whether or not this ever renders. The second is harder, and is a rule the
 * caller MUST honour: `useObjectOutput` throws where the platform has no
 * object-detection output, and a hook cannot be called conditionally. Isolating
 * it means the caller decides not to MOUNT this, rather than catching a
 * render-time exception it has no way to recover from.
 *
 * So: mounting this is the LAST thing the screen does, once
 * `SCANNING_IS_SUPPORTED` holds, permission is granted, and a real camera
 * exists.
 *
 * WHY THERE IS NO ML KIT HERE. The obvious dependency,
 * react-native-vision-camera-barcode-scanner, is backed by Google ML Kit, which
 * ships x86_64-only simulator slices and forces EXCLUDED_ARCHS = arm64 onto the
 * whole app - making the app impossible to run in a simulator on any Apple
 * Silicon Mac, which is every Mac sold since 2020. See
 * docs/adr-001-qr-scanning.md. Vision Camera's own object output does the same
 * job with nothing to exclude an architecture for.
 *
 * WHAT THAT COSTS, stated plainly because it is a real hole rather than a
 * detail: `createObjectOutput` is implemented on iOS only in Vision Camera
 * 5.2.3 - the Android factory throws outright - so there is no camera pairing on
 * Android until either a pure-JS decoder is added back as a dependency (the
 * route the ADR describes, which needs `jsqr`, currently not installed) or a
 * native detector is written. Android users pair by showing their own code or by
 * comparing six digits, and the screen says so rather than pretending.
 */

/**
 * True where Vision Camera actually implements a code-scanning output.
 *
 * There is no runtime feature test to use instead: the only way to ask is to
 * call `createObjectOutput`, and on Android that throws rather than returning
 * null. So this is a platform check, and it is the single line to delete the day
 * Android gains an implementation.
 */
export const SCANNING_IS_SUPPORTED = Platform.OS === 'ios';

/**
 * Only QR.
 *
 * Reading every format would happily lock onto the barcode on a boarding pass,
 * which is precisely the situation this app is used in. The module-level
 * constant keeps the array identity stable across renders, so the native output
 * is not reconfigured on every frame.
 */
const QR_ONLY: ScannedObjectType[] = ['qr'];

export interface ScannerCameraProps {
  readonly device: CameraDevice;
  /** False while a result is on screen, so scanning cannot re-fire behind a card. */
  readonly isActive: boolean;
  /** Fires once per distinct code. The screen decides what to do with it. */
  readonly onCode: (value: string) => void;
  /** A camera that will never produce a frame. The screen shows a way forward. */
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
  /**
   * The same code is reported on every frame it stays in view, which at 30fps
   * would call onCode thirty times a second and push thirty result screens.
   */
  const lastValue = useRef<string | null>(null);

  const handleScanned = useCallback(
    (objects: ScannedObject[]) => {
      if (!isActive) return;
      for (const object of objects) {
        if (!isScannedCode(object)) continue;
        // A damaged or partly-obscured code decodes to nothing. Keep looking.
        const value = object.value;
        if (!value) continue;
        if (value === lastValue.current) return;
        lastValue.current = value;
        onCode(value);
        return;
      }
    },
    [isActive, onCode],
  );

  // A fresh scanning session may legitimately want to re-read the code it just
  // reported - the user could be pointing at the same phone on purpose.
  useEffect(() => {
    if (isActive) lastValue.current = null;
  }, [isActive]);

  const objectOutput = useObjectOutput({ types: QR_ONLY, onObjectsScanned: handleScanned });

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
        device={device}
        isActive={isActive}
        outputs={[objectOutput]}
        style={{ flex: 1 }}
        onError={onError}
      />
      <Viewfinder />
    </View>
  );
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
