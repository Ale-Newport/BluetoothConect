import React, { useCallback } from 'react';
import { View, type ViewStyle } from 'react-native';
import { Camera, type CameraDevice } from 'react-native-vision-camera';
import { useBarcodeScannerOutput } from 'react-native-vision-camera-barcode-scanner';
import { useTheme } from '../../ui/index.js';

/**
 * The camera surface, and nothing else.
 *
 * Kept in its own file for one reason: everything in here talks to a native
 * module, and the screen around it has to keep working - explaining permissions,
 * explaining a missing camera, showing a result - whether or not this ever
 * renders. Mounting it is the LAST thing the screen does, once permission is
 * granted and a real device exists.
 */

/** Only QR. Scanning every format would happily read the barcode on a boarding pass. */
const FORMATS = ['qr-code'] as const;

export function ScannerCamera({
  device,
  isActive,
  onCode,
  onError,
}: {
  device: CameraDevice;
  isActive: boolean;
  /** The raw string off the code. Validation belongs to the strict parser, not here. */
  onCode: (value: string) => void;
  onError: (error: Error) => void;
}): React.JSX.Element {
  const theme = useTheme();

  const handleBarcodes = useCallback(
    (barcodes: { readonly rawValue: string | undefined }[]) => {
      for (const barcode of barcodes) {
        const value = barcode.rawValue;
        // One code per frame is all we act on. A frame with two AirLink codes in
        // it is somebody's screenshot collage, not two friends.
        if (typeof value === 'string' && value.length > 0) {
          onCode(value);
          return;
        }
      }
    },
    [onCode],
  );

  const output = useBarcodeScannerOutput({
    barcodeFormats: [...FORMATS],
    onBarcodeScanned: handleBarcodes,
    onError,
  });

  return (
    <View style={{ flex: 1, overflow: 'hidden', borderRadius: theme.radius.lg, backgroundColor: theme.colors.scrim }}>
      <Camera
        style={{ flex: 1 }}
        device={device}
        isActive={isActive}
        outputs={[output]}
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
