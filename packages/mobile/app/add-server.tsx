/**
 * Add-server modal: three ways in — manual host entry, QR scan (the desktop app
 * renders one in Settings → Pair mobile app), and mDNS auto-discovery. QR and mDNS
 * still land on a review card before saving, so a token prompt can slot in when
 * the server advertises `token=required`.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { BlockingmachineClient, ApiError, normalizeBaseUrl } from '../src/api/client';
import { browseServers, DiscoveredServer, isDiscoveryAvailable } from '../src/api/discovery';
import { decodePairingPayload, PairingError, type PairingPayload } from '../src/api/pairing';
import { useServers } from '../src/state/servers';
import { ActionButton, Card, Pill } from '../src/components/ui';
import { GlassBackdrop } from '../src/components/GlassBackdrop';
import { colors, glass, spacing } from '../src/theme';

type Mode = 'pick' | 'manual' | 'qr' | 'discover';

interface PendingSave {
  baseUrl: string;
  label: string;
  origin: 'manual' | 'qr' | 'mdns';
  token?: string;
}

export default function AddServerScreen() {
  const { addServer } = useServers();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>('pick');
  const [host, setHost] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [pending, setPending] = useState<PendingSave | null>(null);

  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);
  const [found, setFound] = useState<Record<string, DiscoveredServer>>({});
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'discover' || !isDiscoveryAvailable()) return;
    const session = browseServers({
      onFound: (s) =>
        setFound((prev) => ({ ...prev, [`${s.host}:${s.port}`]: s })),
      onRemove: (name) =>
        setFound((prev) =>
          Object.fromEntries(
            Object.entries(prev).filter(([, s]) => s.name !== name),
          ),
        ),
      onError: (e) => setDiscoverError(e.message),
    });
    return () => session.stop();
  }, [mode]);

  const testAndStage = async (candidate: PendingSave) => {
    setTesting(true);
    setError(null);
    try {
      const client = new BlockingmachineClient({
        baseUrl: candidate.baseUrl,
        token: candidate.token,
      });
      const status = await client.getStatus();
      setPending({
        ...candidate,
        label: candidate.label || status.service || candidate.baseUrl,
      });
    } catch (err) {
      setError(
        err instanceof ApiError && err.kind === 'unauthorized'
          ? 'Server answered but needs a token — enter it below and retry.'
          : `Can't reach ${candidate.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!pending) return;
    await addServer(
      { baseUrl: pending.baseUrl, label: pending.label, origin: pending.origin },
      pending.token || token || undefined,
    );
    router.back();
  };

  // QR codes can carry alternate LAN URLs for multi-homed hosts — try each in
  // order and stage the first that answers. An "unauthorized" answer still
  // counts as reachable: the review card's token field handles the auth.
  const stageQr = async (payload: PairingPayload) => {
    setTesting(true);
    setError(null);
    const candidates = payload.urls?.length ? payload.urls : [payload.url];
    let unauthorizedUrl: string | null = null;
    for (const baseUrl of candidates) {
      try {
        const client = new BlockingmachineClient({ baseUrl, token: payload.token });
        const status = await client.getStatus();
        setPending({
          baseUrl,
          label: status.service || 'Paired hub',
          origin: 'qr',
          token: payload.token,
        });
        setTesting(false);
        return;
      } catch (err) {
        if (err instanceof ApiError && err.kind === 'unauthorized') {
          unauthorizedUrl = baseUrl;
          break;
        }
      }
    }
    if (unauthorizedUrl) {
      setPending({
        baseUrl: unauthorizedUrl,
        label: 'Paired hub',
        origin: 'qr',
        token: payload.token,
      });
    } else {
      setError(
        candidates.length > 1
          ? `The code listed ${candidates.length} hub addresses — none answered. Check both devices are on the same network.`
          : `Can't reach ${candidates[0]} — check both devices are on the same network.`,
      );
      scannedRef.current = false;
    }
    setTesting(false);
  };

  const onBarcode = ({ data }: { data: string }) => {
    if (scannedRef.current) return;
    scannedRef.current = true;
    try {
      void stageQr(decodePairingPayload(data));
    } catch (err) {
      setError(err instanceof PairingError ? err.message : 'Unreadable QR code');
      scannedRef.current = false;
    }
  };

  return (
    <View style={styles.screen}>
      <GlassBackdrop />
      <ScrollView
        style={styles.scroll}
      contentContainerStyle={[styles.content, { paddingBottom: spacing.xl + insets.bottom }]}
    >
      {pending ? (
        <Card>
          <Text style={styles.sectionTitle}>Server reached</Text>
          <Text style={styles.serverName}>{pending.label}</Text>
          <Text style={styles.meta}>{pending.baseUrl}</Text>
          {!pending.token ? (
            <TextInput
              style={styles.input}
              placeholder="feed token (if the server requires one)"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              value={token}
              onChangeText={setToken}
            />
          ) : null}
          <View style={styles.buttonRow}>
            <View style={styles.buttonFlex}>
              <ActionButton label="Save" onPress={() => void save()} />
            </View>
            <View style={styles.buttonFlex}>
              <ActionButton
                label="Back"
                tone="ghost"
                onPress={() => {
                  setPending(null);
                  scannedRef.current = false; // let a dismissed QR be scanned again
                }}
              />
            </View>
          </View>
        </Card>
      ) : null}

      {error ? (
        <Card style={styles.errorCard}>
          <Text style={styles.errorText}>{error}</Text>
        </Card>
      ) : null}

      {mode === 'pick' && !pending ? (
        <>
          <Text style={styles.sectionTitle}>How do you want to connect?</Text>
          <Pressable
            style={({ pressed }) => [styles.modeCard, pressed && styles.pressed]}
            android_ripple={{ color: 'rgba(255,255,255,0.06)' }}
            onPress={() => setMode('manual')}
          >
            <Text style={styles.modeTitle}>Enter address</Text>
            <Text style={styles.meta}>Type the hub's LAN address, e.g. 192.168.1.10:9191</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.modeCard, pressed && styles.pressed]}
            android_ripple={{ color: 'rgba(255,255,255,0.06)' }}
            onPress={async () => {
              if (!permission?.granted) await requestPermission();
              setMode('qr');
            }}
          >
            <Text style={styles.modeTitle}>Scan pairing QR</Text>
            <Text style={styles.meta}>
              The desktop app shows one under Settings → Pair mobile app
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.modeCard, pressed && styles.pressed]}
            android_ripple={{ color: 'rgba(255,255,255,0.06)' }}
            onPress={() => setMode('discover')}
          >
            <Text style={styles.modeTitle}>Find on network</Text>
            <Text style={styles.meta}>
              Look for Blockingmachine servers advertising themselves on the LAN
            </Text>
          </Pressable>
        </>
      ) : null}

      {mode === 'manual' && !pending ? (
        <Card>
          <Text style={styles.sectionTitle}>Server address</Text>
          <TextInput
            style={styles.input}
            placeholder="192.168.1.10:9191 or http://hub.local:9191"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={host}
            onChangeText={setHost}
          />
          <TextInput
            style={styles.input}
            placeholder="feed token (optional)"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            value={token}
            onChangeText={setToken}
          />
          <View style={styles.buttonRow}>
            <View style={styles.buttonFlex}>
              <ActionButton
                label={testing ? 'Testing…' : 'Test & continue'}
                loading={testing}
                disabled={!host.trim()}
                onPress={() => {
                  let baseUrl: string;
                  try {
                    baseUrl = normalizeBaseUrl(host);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Invalid address');
                    return;
                  }
                  void testAndStage({
                    baseUrl,
                    label: '',
                    origin: 'manual',
                    token: token || undefined,
                  });
                }}
              />
            </View>
            <View style={styles.buttonFlex}>
              <ActionButton label="Back" tone="ghost" onPress={() => setMode('pick')} />
            </View>
          </View>
        </Card>
      ) : null}

      {mode === 'qr' && !pending ? (
        <Card>
          <Text style={styles.sectionTitle}>Scan pairing QR</Text>
          {permission?.granted ? (
            <View style={styles.cameraWrap}>
              <CameraView
                style={styles.camera}
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={onBarcode}
              />
            </View>
          ) : (
            <>
              <Text style={styles.meta}>
                Camera permission is needed to scan the pairing code.
              </Text>
              <ActionButton
                label="Grant camera access"
                onPress={() => void requestPermission()}
              />
            </>
          )}
          {testing ? (
            <Text style={[styles.meta, { marginTop: spacing.sm }]}>
              Trying the hub addresses from the code…
            </Text>
          ) : null}
          <View style={[styles.buttonRow, { marginTop: spacing.sm }]}>
            <View style={styles.buttonFlex}>
              <ActionButton label="Back" tone="ghost" onPress={() => setMode('pick')} />
            </View>
          </View>
        </Card>
      ) : null}

      {mode === 'discover' && !pending ? (
        <Card>
          <Text style={styles.sectionTitle}>On this network</Text>
          {!isDiscoveryAvailable() ? (
            <Text style={styles.meta}>
              mDNS discovery needs the dev-client build — it isn't available in Expo
              Go. Use manual entry or QR instead.
            </Text>
          ) : discoverError ? (
            <Text style={styles.errorText}>{discoverError}</Text>
          ) : Object.keys(found).length === 0 ? (
            <Text style={styles.meta}>Searching for _blockingmachine._tcp…</Text>
          ) : (
            Object.values(found).map((s) => (
              <Pressable
                key={`${s.host}:${s.port}`}
                style={({ pressed }) => [styles.foundRow, pressed && styles.pressed]}
                android_ripple={{ color: 'rgba(255,255,255,0.06)' }}
                accessibilityRole="button"
                onPress={() =>
                  void testAndStage({
                    baseUrl: `http://${s.host}:${s.port}`,
                    label: s.name,
                    origin: 'mdns',
                  })
                }
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.serverName}>{s.name}</Text>
                  <Text style={styles.meta}>
                    {s.host}:{s.port}
                    {s.txt.version ? ` · v${s.txt.version}` : ''}
                  </Text>
                </View>
                {s.txt.token === 'required' ? (
                  <Pill label="needs token" tone="warn" />
                ) : (
                  <Pill label="open" tone="ok" />
                )}
              </Pressable>
            ))
          )}
          <View style={[styles.buttonRow, { marginTop: spacing.sm }]}>
            <View style={styles.buttonFlex}>
              <ActionButton label="Back" tone="ghost" onPress={() => setMode('pick')} />
            </View>
          </View>
        </Card>
      ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  scroll: { flex: 1 },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  sectionTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  modeCard: {
    backgroundColor: glass.surface,
    borderColor: glass.border,
    borderTopColor: glass.borderTop,
    borderRadius: 20,
    borderWidth: 1,
    marginBottom: spacing.md,
    padding: spacing.md,
  },
  pressed: { opacity: 0.7 },
  modeTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  meta: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
  serverName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  input: {
    backgroundColor: glass.surface,
    borderColor: glass.border,
    borderTopColor: glass.borderTop,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.text,
    fontSize: 15,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  buttonRow: { flexDirection: 'row', gap: spacing.sm },
  buttonFlex: { flex: 1 },
  cameraWrap: { borderRadius: 12, overflow: 'hidden' },
  camera: { aspectRatio: 1, width: '100%' },
  foundRow: {
    alignItems: 'center',
    borderTopColor: glass.border,
    borderTopWidth: 1,
    flexDirection: 'row',
    paddingVertical: spacing.sm,
  },
  errorCard: { borderColor: colors.danger },
  errorText: { color: colors.danger, fontSize: 13 },
});
