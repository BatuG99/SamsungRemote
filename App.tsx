import { useEffect, useRef, useState } from 'react';
import {
  NativeModules,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Contrast,
  House,
  LogIn,
  Minus,
  Moon,
  Play,
  Plus,
  Power,
  Settings,
  Sun,
  Undo2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react-native';

type SamsungWebSocketModule = {
  connect: (url: string) => Promise<boolean>;
  send: (message: string) => Promise<boolean>;
  wake: (macAddress: string, broadcastAddress: string) => Promise<boolean>;
  close: () => void;
};

const SamsungWebSocket = NativeModules.SamsungWebSocket as
  | SamsungWebSocketModule
  | undefined;

const TV_IP = '192.168.178.21';
const TV_MAC = 'e0:9d:13:51:d2:ee';
const TV_BROADCAST_ADDRESS = '192.168.178.255';

const TV_URL = `wss://${TV_IP}:8002/api/v2/channels/samsung.remote.control`;

const YOUTUBE_APP_ID = '111299001912';
const MENU_DELAY_MS = 1800;
const SETTINGS_TRANSITION_DELAY_MS = 1000;
const TV_CONNECT_ATTEMPTS = 10;
const TV_CONNECT_RETRY_DELAY_MS = 1500;
const TV_WAKE_SETTLE_DELAY_MS = 3000;
const TV_WAKE_RETRY_AFTER_FAILED_ATTEMPTS = 2;
const TV_POWER_STATE_TIMEOUT_MS = 2000;
const POWER_OFF_GUARD_MS = 3000;

type PowerTransition = {
  phase: 'idle' | 'poweringOff' | 'poweringOn';
  powerOnQueued: boolean;
};

function sleep(ms: number) {
  return new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });
}

async function isTVPoweredOn() {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, TV_POWER_STATE_TIMEOUT_MS);

  try {
    const response = await fetch(`http://${TV_IP}:8001/api/v2/`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return false;
    }

    const status = (await response.json()) as {
      device?: { PowerState?: string };
    };

    return status.device?.PowerState?.toLowerCase() === 'on';
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function App() {
  const [connected, setConnected] = useState(false);
  const [powerError, setPowerError] = useState<'startFailed' | null>(null);
  const [powerPhase, setPowerPhase] =
    useState<PowerTransition['phase']>('idle');
  const powerTransition = useRef<PowerTransition>({
    phase: 'idle',
    powerOnQueued: false,
  });

  useEffect(() => {
    async function connectToTV() {
      if (!SamsungWebSocket) {
        console.error('Native SamsungWebSocket module not found');
        return;
      }

      try {
        console.log('Connecting to Samsung TV...');

        await SamsungWebSocket.connect(TV_URL);

        if (!(await isTVPoweredOn())) {
          SamsungWebSocket.close();
          throw new Error('Samsung TV WebSocket is reachable, but TV is off');
        }

        setConnected(true);
        setPowerError(null);

        console.log('Samsung TV connected');
      } catch (error) {
        setConnected(false);

        console.log('Samsung TV is offline:', error);
      }
    }

    connectToTV();

    return () => {
      SamsungWebSocket?.close();
    };
  }, []);

  async function sendKey(key: string) {
    if (!SamsungWebSocket || !connected) {
      console.log('TV is not connected');
      return false;
    }

    const command = {
      method: 'ms.remote.control',
      params: {
        Cmd: 'Click',
        DataOfCmd: key,
        Option: 'false',
        TypeOfRemote: 'SendRemoteKey',
      },
    };

    try {
      await SamsungWebSocket.send(JSON.stringify(command));

      console.log('Sent:', key);
      return true;
    } catch (error) {
      console.error(`Could not send ${key}:`, error);
      return false;
    }
  }

  async function togglePower() {
    if (!SamsungWebSocket) {
      console.error('Native SamsungWebSocket module not found');
      return;
    }

    if (powerTransition.current.phase === 'poweringOff') {
      powerTransition.current.powerOnQueued = true;
      console.log('Queued power-on until the TV has finished shutting down');
      return;
    }

    if (powerTransition.current.phase === 'poweringOn') {
      console.log('Ignoring power press while power transition is in progress');
      return;
    }

    await performPowerToggle(!connected);
  }

  async function performPowerToggle(requestedPowerOn: boolean) {
    if (!SamsungWebSocket) {
      return;
    }

    let powerOn = requestedPowerOn;
    powerTransition.current.phase = powerOn ? 'poweringOn' : 'poweringOff';
    setPowerPhase(powerTransition.current.phase);
    setPowerError(null);

    try {
      if (!powerOn) {
        const powerOffSent = await sendKey('KEY_POWER');

        if (powerOffSent) {
          setConnected(false);
          return;
        }

        console.log(
          'Power command failed on stale connection; falling back to Wake-on-LAN',
        );
        powerOn = true;
        powerTransition.current.phase = 'poweringOn';
        setPowerPhase('poweringOn');
        setConnected(false);
      }

      await SamsungWebSocket.wake(TV_MAC, TV_BROADCAST_ADDRESS);
      await sleep(TV_WAKE_SETTLE_DELAY_MS);

      let lastConnectionError: unknown;

      for (let attempt = 0; attempt < TV_CONNECT_ATTEMPTS; attempt += 1) {
        try {
          await SamsungWebSocket.connect(TV_URL);

          if (!(await isTVPoweredOn())) {
            SamsungWebSocket.close();
            throw new Error(
              'Samsung TV WebSocket is reachable, but TV is not powered on yet',
            );
          }

          setConnected(true);
          lastConnectionError = undefined;
          break;
        } catch (error) {
          lastConnectionError = error;
          setConnected(false);

          if (attempt < TV_CONNECT_ATTEMPTS - 1) {
            if (
              (attempt + 1) % TV_WAKE_RETRY_AFTER_FAILED_ATTEMPTS ===
              0
            ) {
              console.log('Repeating Wake-on-LAN while TV is starting');
              await SamsungWebSocket.wake(TV_MAC, TV_BROADCAST_ADDRESS);
            }

            await sleep(TV_CONNECT_RETRY_DELAY_MS);
          }
        }
      }

      if (lastConnectionError) {
        throw lastConnectionError;
      }
    } catch (error) {
      setConnected(false);
      if (powerOn) {
        setPowerError('startFailed');
      }
      console.log('Could not change Samsung TV power state:', error);
    } finally {
      if (!powerOn) {
        await sleep(POWER_OFF_GUARD_MS);
      }

      const shouldStartQueuedPowerOn =
        powerTransition.current.phase === 'poweringOff' &&
        powerTransition.current.powerOnQueued;

      powerTransition.current.phase = 'idle';
      powerTransition.current.powerOnQueued = false;

      if (shouldStartQueuedPowerOn) {
        console.log('Starting queued power-on after shutdown guard');
        await performPowerToggle(true);
      } else {
        setPowerPhase('idle');
      }
    }
  }

  const statusLabel =
    powerPhase === 'poweringOn'
      ? 'Starting…'
      : powerPhase === 'poweringOff'
      ? 'Powering off…'
      : powerError === 'startFailed'
      ? 'Start failed'
      : connected
      ? 'Connected'
      : 'Offline';

  async function openSettingsMenu() {
    await sendKey('KEY_MENU');
    await sleep(MENU_DELAY_MS);
  }

  async function openBrightness() {
    if (!connected) {
      console.log('TV is not connected');
      return;
    }

    console.log('Opening brightness control...');

    await openSettingsMenu();

    await sendKey('KEY_ENTER');
    await sleep(SETTINGS_TRANSITION_DELAY_MS);

    await sendKey('KEY_DOWN');
    await sleep(250);

    await sendKey('KEY_DOWN');
    await sleep(250);

    await sendKey('KEY_ENTER');
    await sleep(500);

    await sendKey('KEY_ENTER');
    await sleep(300);

    console.log('Brightness slider opened');
  }

  async function openPictureModeMenu() {
    await openSettingsMenu();

    await sendKey('KEY_ENTER');
    await sleep(SETTINGS_TRANSITION_DELAY_MS);

    await sendKey('KEY_ENTER');
    await sleep(SETTINGS_TRANSITION_DELAY_MS);
  }
  async function setNightMode() {
    if (!connected) {
      console.log('TV is not connected');
      return;
    }

    console.log('Switching to night mode...');

    await openPictureModeMenu();

    // Der Bildmodus Dialog braucht offenbar etwas Zeit,
    // bevor die Navigation zuverlässig angenommen wird.
    await sleep(700);

    await sendKey('KEY_DOWN');
    await sleep(500);

    await sendKey('KEY_ENTER');
    await sleep(1000);

    // Eine Ebene zurück
    await sendKey('KEY_RETURN');
    await sleep(700);

    // Settings komplett schließen
    await sendKey('KEY_MENU');
    await sleep(700);

    await sendKey('KEY_RETURN');
    await sleep(300);

    console.log('Night mode active');
  }

  async function setDayMode() {
    if (!connected) {
      console.log('TV is not connected');
      return;
    }

    console.log('Switching to day mode...');

    await openPictureModeMenu();

    await sendKey('KEY_UP');
    await sleep(300);

    await sendKey('KEY_ENTER');
    await sleep(600);

    await sendKey('KEY_LEFT');
    await sleep(300);

    await sendKey('KEY_ENTER');
    await sleep(500);

    await sendKey('KEY_RETURN');
    await sleep(700);

    await sendKey('KEY_MENU');
    await sleep(700);

    await sendKey('KEY_RETURN');
    await sleep(300);

    console.log('Day mode active');
  }
  async function launchApp(appId: string) {
    try {
      const response = await fetch(
        `http://${TV_IP}:8001/api/v2/applications/${appId}`,
        {
          method: 'POST',
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      console.log('App launched:', appId);
    } catch (error) {
      console.error('Could not launch app:', error);
    }
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar barStyle="light-content" backgroundColor="#090a0d" />

        <ScrollView
          contentContainerStyle={styles.container}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.remoteSurface}>
            <View style={styles.header}>
              <View>
                <Text style={styles.eyebrow}>SMART CONTROL</Text>
                <Text style={styles.title}>Samsung TV</Text>
              </View>

              <View style={styles.statusPill}>
                <View
                  style={[
                    styles.statusDot,
                    powerPhase !== 'idle'
                      ? styles.transitionDot
                      : connected
                      ? styles.connectedDot
                      : styles.disconnectedDot,
                  ]}
                />

                <Text style={styles.statusText}>{statusLabel}</Text>
              </View>
            </View>

            <View style={styles.quickActionRow}>
              <RemoteButton
                label="Power"
                icon={Power}
                wide
                busy={powerPhase !== 'idle'}
                disabled={powerPhase === 'poweringOn'}
                onPress={togglePower}
              />

              <RemoteButton
                label="YouTube"
                icon={Play}
                wide
                accent
                onPress={() => launchApp(YOUTUBE_APP_ID)}
              />
            </View>

            <View style={styles.pictureCard}>
              <Text style={styles.controlLabel}>PICTURE</Text>

              <View style={styles.pictureActions}>
                <RemoteButton
                  label="Brightness"
                  icon={Contrast}
                  compact
                  onPress={openBrightness}
                />

                <RemoteButton
                  label="Day mode"
                  icon={Sun}
                  compact
                  onPress={setDayMode}
                />

                <RemoteButton
                  label="Night mode"
                  icon={Moon}
                  compact
                  onPress={setNightMode}
                />
              </View>
            </View>

            <View style={styles.navigationCard}>
              <RemoteButton
                label="Up"
                icon={ArrowUp}
                round
                onPress={() => sendKey('KEY_UP')}
              />

              <View style={styles.navigationMiddle}>
                <RemoteButton
                  label="Left"
                  icon={ArrowLeft}
                  round
                  onPress={() => sendKey('KEY_LEFT')}
                />

                <RemoteButton
                  label="OK"
                  text="OK"
                  round
                  primary
                  onPress={() => sendKey('KEY_ENTER')}
                />

                <RemoteButton
                  label="Right"
                  icon={ArrowRight}
                  round
                  onPress={() => sendKey('KEY_RIGHT')}
                />
              </View>

              <RemoteButton
                label="Down"
                icon={ArrowDown}
                round
                onPress={() => sendKey('KEY_DOWN')}
              />
            </View>

            <View style={styles.actionRow}>
              <RemoteButton
                label="Back"
                icon={Undo2}
                wide
                onPress={() => sendKey('KEY_RETURN')}
              />

              <RemoteButton
                label="Home"
                icon={House}
                wide
                onPress={() => sendKey('KEY_HOME')}
              />

              <RemoteButton
                label="Settings"
                icon={Settings}
                wide
                onPress={() => sendKey('KEY_MENU')}
              />
            </View>

            <View style={styles.controlCard}>
              <View style={styles.controlColumn}>
                <Text style={styles.controlLabel}>VOLUME</Text>

                <View style={styles.controlButtons}>
                  <RemoteButton
                    label="Volume up"
                    icon={Plus}
                    round
                    onPress={() => sendKey('KEY_VOLUP')}
                  />

                  <RemoteButton
                    label="Volume down"
                    icon={Minus}
                    round
                    onPress={() => sendKey('KEY_VOLDOWN')}
                  />
                </View>
              </View>

              <View style={styles.controlDivider} />

              <View style={styles.controlColumn}>
                <Text style={styles.controlLabel}>CHANNEL</Text>

                <View style={styles.controlButtons}>
                  <RemoteButton
                    label="Channel up"
                    icon={Plus}
                    round
                    onPress={() => sendKey('KEY_CHUP')}
                  />

                  <RemoteButton
                    label="Channel down"
                    icon={Minus}
                    round
                    onPress={() => sendKey('KEY_CHDOWN')}
                  />
                </View>
              </View>
            </View>

            <View style={styles.bottomRow}>
              <RemoteButton
                label="Mute"
                icon={VolumeX}
                caption="MUTE"
                wide
                onPress={() => sendKey('KEY_MUTE')}
              />

              <RemoteButton
                label="Source"
                icon={LogIn}
                caption="SOURCE"
                wide
                onPress={() => sendKey('KEY_SOURCE')}
              />
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

type RemoteButtonProps = {
  label: string;
  icon?: LucideIcon;
  text?: string;
  caption?: string;
  onPress: () => void | Promise<void>;
  round?: boolean;
  primary?: boolean;
  accent?: boolean;
  compact?: boolean;
  wide?: boolean;
  busy?: boolean;
  disabled?: boolean;
};

function RemoteButton({
  label,
  icon,
  text,
  caption,
  onPress,
  round = false,
  primary = false,
  accent = false,
  compact = false,
  wide = false,
  busy = false,
  disabled = false,
}: RemoteButtonProps) {
  const Icon = icon;
  const iconColor = busy ? '#777f8b' : primary ? '#111318' : '#e8ebef';

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ busy, disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        round && styles.roundButton,
        compact && styles.compactButton,
        wide && styles.wideButton,
        primary && styles.primaryButton,
        accent && styles.accentButton,
        busy && styles.busyButton,
        pressed && styles.buttonPressed,
      ]}
    >
      <View style={styles.buttonContent}>
        {Icon ? (
          <Icon color={iconColor} size={23} strokeWidth={2.2} />
        ) : (
          <Text style={[styles.buttonText, primary && styles.primaryText]}>
            {text}
          </Text>
        )}

        {caption ? <Text style={styles.buttonCaption}>{caption}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#090a0d',
  },

  container: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#090a0d',
  },

  remoteSurface: {
    width: '100%',
    maxWidth: 430,
    alignSelf: 'center',
    padding: 18,
    borderRadius: 32,
    backgroundColor: '#111318',
    borderWidth: 1,
    borderColor: '#20242c',
  },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
    paddingHorizontal: 2,
  },

  eyebrow: {
    marginBottom: 3,
    color: '#6f7682',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.7,
  },

  title: {
    color: '#f6f7f9',
    fontSize: 23,
    fontWeight: '700',
    letterSpacing: -0.5,
  },

  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: '#181b21',
    borderWidth: 1,
    borderColor: '#252a33',
  },

  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },

  connectedDot: {
    backgroundColor: '#55e785',
  },

  disconnectedDot: {
    backgroundColor: '#ff6262',
  },

  transitionDot: {
    backgroundColor: '#f1b84b',
  },

  statusText: {
    color: '#a9afb9',
    fontSize: 11,
    fontWeight: '600',
  },

  quickActionRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },

  pictureCard: {
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 9,
    borderRadius: 22,
    backgroundColor: '#0d0f13',
    borderWidth: 1,
    borderColor: '#1d2128',
  },

  pictureActions: {
    flexDirection: 'row',
    gap: 9,
  },

  navigationCard: {
    alignItems: 'center',
    marginBottom: 12,
    paddingVertical: 13,
    gap: 4,
    borderRadius: 24,
    backgroundColor: '#0d0f13',
    borderWidth: 1,
    borderColor: '#1d2128',
  },

  navigationMiddle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },

  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },

  controlCard: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 13,
    borderRadius: 22,
    backgroundColor: '#0d0f13',
    borderWidth: 1,
    borderColor: '#1d2128',
  },

  controlColumn: {
    flex: 1,
    alignItems: 'center',
    gap: 9,
  },

  controlButtons: {
    flexDirection: 'row',
    gap: 9,
  },

  controlDivider: {
    width: 1,
    marginHorizontal: 10,
    backgroundColor: '#20242b',
  },

  controlLabel: {
    color: '#666d78',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.4,
  },

  bottomRow: {
    flexDirection: 'row',
    gap: 10,
  },

  button: {
    minWidth: 104,
    height: 46,
    paddingHorizontal: 14,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1a1d23',
    borderWidth: 1,
    borderColor: '#292e37',
  },

  compactButton: {
    flex: 1,
    minWidth: 0,
    height: 50,
    paddingHorizontal: 0,
    borderRadius: 16,
  },

  wideButton: {
    flex: 1,
    minWidth: 0,
  },

  roundButton: {
    minWidth: 48,
    width: 48,
    height: 48,
    borderRadius: 24,
    paddingHorizontal: 0,
  },

  primaryButton: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#f2f4f7',
    borderColor: '#ffffff',
  },

  accentButton: {
    backgroundColor: '#d61627',
    borderColor: '#ef3444',
  },

  busyButton: {
    opacity: 0.58,
    borderColor: '#4a515d',
    transform: [{ scale: 0.95 }],
  },

  buttonPressed: {
    opacity: 0.68,
    transform: [{ scale: 0.95 }],
  },

  buttonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
  },

  buttonCaption: {
    color: '#8b929e',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.2,
  },

  buttonText: {
    color: '#e8ebef',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.6,
    textAlign: 'center',
  },

  primaryText: {
    color: '#111318',
  },
});

export default App;
