import React from 'react';
import { View } from 'react-native';
import { strings } from '@airlink/config';
import { Card, Gap, Label, Screen, SectionHeading, useTheme } from '../../ui/index.js';
import { local } from './localStrings.js';

/**
 * Privacy.
 *
 * A page of plain statements, in the same calm voice as the rest of the app.
 * There is no consent flow here and nothing to opt out of, because there is
 * nothing collected to opt out of - which is the whole point, and the reason
 * this page can be short.
 *
 * `navigation/routes.ts` has no Privacy route and the navigator is not this
 * agent's to edit, so the content lives in `PrivacyPanel` and the You screen
 * presents it as a page. If a route is added later, `PrivacyScreen` below is
 * ready to be wired to it.
 */

function Bullet({ children }: { children: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
      <View
        style={{
          width: theme.spacing.xs + 2,
          height: theme.spacing.xs + 2,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.textTertiary,
          // Nudge the dot onto the first line's optical centre.
          marginTop: theme.spacing.sm,
        }}
      />
      <Label variant="subheadline" tone="secondary" style={{ flex: 1 }}>
        {children}
      </Label>
    </View>
  );
}

export function PrivacyPanel(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View accessible={false}>
      <Label variant="title2">{local.privacy.lead}</Label>
      <Gap size="sm" />
      <Label variant="body" tone="secondary">
        {strings.profile.privacyBody}
      </Label>

      <Gap size="xl" />
      <SectionHeading>{local.privacy.doesTitle}</SectionHeading>
      <Card>
        <View style={{ gap: theme.spacing.md }}>
          {local.privacy.does.map((line) => (
            <Bullet key={line}>{line}</Bullet>
          ))}
        </View>
      </Card>

      <Gap size="xl" />
      <SectionHeading>{local.privacy.doesNotTitle}</SectionHeading>
      <Card>
        <View style={{ gap: theme.spacing.md }}>
          {local.privacy.doesNot.map((line) => (
            <Bullet key={line}>{line}</Bullet>
          ))}
        </View>
      </Card>

      <Gap size="xl" />
      <SectionHeading>{local.privacy.identityTitle}</SectionHeading>
      <Card>
        <Label variant="subheadline" tone="secondary">
          {local.privacy.identityBody}
        </Label>
      </Card>

      <Gap size="xl" />
      <SectionHeading>{local.privacy.controlTitle}</SectionHeading>
      <Card>
        <Label variant="subheadline" tone="secondary">
          {local.privacy.controlBody}
        </Label>
      </Card>
    </View>
  );
}

/** Ready for a `Privacy` route the day the route map gains one. */
export function PrivacyScreen(): React.JSX.Element {
  return (
    <Screen scroll>
      <Gap size="lg" />
      <PrivacyPanel />
    </Screen>
  );
}
