import React, { useCallback, useRef } from 'react';
import { View } from 'react-native';
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
 * whether or not this ever renders. The second is harder: `useObjectOutput`
 * throws where the platform has no object-detection output, and a hook cannot
 * be called conditionally. Isolating it means the caller decides not to MOUNT
 * this, rather than catching a render-time exception it cannot recover from.
 *
 * So: mounting this is the LAST thing the screen does, once the platform
 * supports it, permission is granted, and a real camera exists.
 *
 * WHY THERE IS NO ML KIT HERE. The obvious dependency,
 * react-native-vision-camera-barcode-scanner, is backed by Google ML Kit, which
 * ships x86_64-only simulator slices and forces EXCLUDED_ARCHS = arm64 onto the
 * whole app - making the app impossible to run in a simulator on any Apple
 * Silicon Mac. Vision Camera's own object output does the same job natively,
 * with nothing to exclude an architecture for. See docs/adr-001-qr-scanning.md.
 */

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
  /** Paused while a result is on screen, so it cannot re-fire behind a sheet. */
  readonly isActive: boolean;
  /** Fires once per distinct code. The screen decides what to do with it. */
  readonly onCode: (value: string) => void;
  /** The camera failed to start. The screen shows a way forward. */
  readonly onError: () => void;
}

export function ScannerCamera({ device, isActive, onCode, onError }: ScannerCameraProps): React.JSX.Element {
  const theme = useTheme();
  /**
   * The same code is reported on every frame it stays in view, which at 30 fps
   * would call onCode thirty times a second and push thirty screens.
   */
  const lastValue = useRef<string | null>(null);

  const handleScanned = useCallback(
    (objects: ScannedObject[]) => {
      if (!isActive) return;
      for (const object of objects) {
        if (!isScannedCode(object)) continue;
        // A damaged or partially-visible code decodes to nothing. Keep looking.
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

  const objectOutput = useObjectOutput({ types: QR_ONLY, onObjectsScanned: handleScanned });

  return (
    <View
      style={{
        flex: 1,
        overflow: 'hidden',
        borderRadius: theme.radius.lg,
        backgroundColor: theme.colors.surfaceElevated,
      }}
    >
      <Camera
        device={device}
        isActive={isActive}
        outputs={[objectOutput]}
        style={{ flex: 1 }}
        onError={onError}
      />
    </View>
  );
}
