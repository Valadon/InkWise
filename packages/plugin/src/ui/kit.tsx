import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

/**
 * E-ink friendly building blocks: black on white, thick borders, large tap
 * targets, no animation, no colour.
 */

export function Page({ title, children, onClose }: { title: string; children: React.ReactNode; onClose?: () => void }) {
  return (
    <View style={s.page}>
      <View style={s.header}>
        <Text style={s.title}>{title}</Text>
        {onClose ? <Button label="Close" onPress={onClose} compact /> : null}
      </View>
      <ScrollView style={s.body} contentContainerStyle={s.bodyContent}>
        {children}
      </ScrollView>
    </View>
  );
}

export function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      {title ? <Text style={s.sectionTitle}>{title}</Text> : null}
      {children}
    </View>
  );
}

export function Line({ children, strong, small }: { children: React.ReactNode; strong?: boolean; small?: boolean }) {
  return <Text style={[s.line, strong && s.strong, small && s.small]}>{children}</Text>;
}

export function Quote({ children }: { children: React.ReactNode }) {
  return (
    <View style={s.quote}>
      <Text style={s.quoteText}>{children}</Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  disabled,
  compact,
  primary,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  compact?: boolean;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={disabled ? undefined : onPress}
      style={[s.button, compact && s.buttonCompact, primary && s.buttonPrimary, disabled && s.buttonDisabled]}
    >
      <Text style={[s.buttonText, primary && s.buttonTextPrimary]}>{label}</Text>
    </Pressable>
  );
}

export function Row({ children }: { children: React.ReactNode }) {
  return <View style={s.row}>{children}</View>;
}

export function Field(props: TextInputProps & { label: string }) {
  const { label, style, ...rest } = props;
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput {...rest} style={[s.input, style]} placeholderTextColor="#555" autoCorrect={false} />
    </View>
  );
}

/** A row of mutually exclusive options (segmented control). */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      <View style={s.row}>
        {options.map((o) => (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: o.value === value }}
            onPress={() => onChange(o.value)}
            style={[s.choice, o.value === value && s.choiceOn]}
          >
            <Text style={[s.choiceText, o.value === value && s.choiceTextOn]}>{o.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Choice
      label={label}
      value={value ? 'on' : 'off'}
      options={[
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ]}
      onChange={(v) => onChange(v === 'on')}
    />
  );
}

const BLACK = '#000';
const WHITE = '#fff';

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: WHITE },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 28,
    paddingVertical: 18,
    borderBottomWidth: 3,
    borderColor: BLACK,
  },
  title: { fontSize: 34, fontWeight: 'bold', color: BLACK },
  body: { flex: 1 },
  bodyContent: { padding: 28, paddingBottom: 60 },
  section: { marginBottom: 30 },
  sectionTitle: { fontSize: 26, fontWeight: 'bold', color: BLACK, marginBottom: 12 },
  line: { fontSize: 24, lineHeight: 34, color: BLACK, marginBottom: 6 },
  strong: { fontWeight: 'bold' },
  small: { fontSize: 20, lineHeight: 28 },
  quote: { borderLeftWidth: 5, borderColor: BLACK, paddingLeft: 16, marginVertical: 12 },
  quoteText: { fontSize: 24, lineHeight: 34, color: BLACK, fontStyle: 'italic' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginVertical: 8 },
  button: {
    borderWidth: 3,
    borderColor: BLACK,
    borderRadius: 10,
    paddingVertical: 18,
    paddingHorizontal: 28,
    minHeight: 72,
    minWidth: 150,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: WHITE,
  },
  buttonCompact: { minHeight: 56, paddingVertical: 10, paddingHorizontal: 20, minWidth: 110 },
  buttonPrimary: { backgroundColor: BLACK },
  buttonDisabled: { borderStyle: 'dashed' },
  buttonText: { fontSize: 24, fontWeight: 'bold', color: BLACK },
  buttonTextPrimary: { color: WHITE },
  field: { marginBottom: 18 },
  fieldLabel: { fontSize: 22, color: BLACK, marginBottom: 8 },
  input: {
    borderWidth: 3,
    borderColor: BLACK,
    borderRadius: 8,
    fontSize: 24,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: BLACK,
    backgroundColor: WHITE,
  },
  choice: {
    borderWidth: 3,
    borderColor: BLACK,
    borderRadius: 8,
    paddingVertical: 14,
    paddingHorizontal: 22,
    minHeight: 64,
    justifyContent: 'center',
    backgroundColor: WHITE,
  },
  choiceOn: { backgroundColor: BLACK },
  choiceText: { fontSize: 22, color: BLACK },
  choiceTextOn: { color: WHITE, fontWeight: 'bold' },
});
