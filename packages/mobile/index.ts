// Hermes' built-in URL lacks searchParams/setters on some versions; the polyfill
// keeps the API client's URL handling identical across devices and jest.
import 'react-native-url-polyfill/auto';
import 'expo-router/entry';
