// jest-expo supplies Expo module mocks. AsyncStorage/SecureStore are injected into
// ServerProvider in tests, so no module mocks are needed for them. gesture-handler's
// jestSetup registers its mocks (Swipeable et al. render in unit tests), and
// reanimated/worklets are stubbed — tests never run worklet code.
import 'react-native-gesture-handler/jestSetup';

// The icon font isn't in jest's asset registry — ScreenHeader (and any icon-
// bearing component) would die in expo-font's loadFont. Glyphs are untested.
jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

jest.mock('react-native-reanimated', () =>
  // `require` (not import) — the mock ships no type declarations, and jest
  // factories may not close over imported bindings anyway.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('react-native-reanimated/mock'),
);

// httpsCapture stores the hub data-port token in expo-secure-store — an
// in-memory store keeps those tests hermetic (name must start with "mock"
// for the jest.mock factory to close over it).
const mockSecureStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockSecureStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    mockSecureStore.set(k, v);
  }),
  deleteItemAsync: jest.fn(async (k: string) => {
    mockSecureStore.delete(k);
  }),
}));
