import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.humanpixel.participant',
  appName: 'HUMAN PIXEL',
  webDir: 'dist',
  backgroundColor: '#050508',
  ios: { contentInset: 'never' },
  android: { allowMixedContent: false },
  plugins: {
    Geolocation: {},
  },
};

export default config;
