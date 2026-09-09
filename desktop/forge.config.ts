import { MakerDMG } from '@electron-forge/maker-dmg';
import type { ForgeConfig } from '@electron-forge/shared-types';

const signingIdentity = process.env.RECAPSY_SIGNING_IDENTITY;
const shippedPaths = ['/dist', '/assets', '/package.json'];

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: 'one.recapsy.desktop',
    extendInfo: {
      LSUIElement: true,
    },
    ignore: (file) => file !== '' && !shippedPaths.some((kept) => file.startsWith(kept)),
    osxSign: {
      identity: signingIdentity ?? '-',
      identityValidation: signingIdentity !== undefined,
      optionsForFile: () => ({ hardenedRuntime: false }),
    },
  },
  makers: [new MakerDMG({})],
};

export default config;
