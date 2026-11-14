/** Sponsored NEAR ecosystem links on the Modules home (open in a new tab). */

export type NearAdApp = {
  id: string;
  name: string;
  href: string;
  logo: string;
};

export const NEAR_AD_APPS: NearAdApp[] = [
  {
    id: 'ref',
    name: 'Ref Finance',
    href: 'https://app.ref.finance',
    logo: '/ads/ref.png',
  },
  {
    id: 'nearblocks',
    name: 'NearBlocks',
    href: 'https://nearblocks.io',
    logo: '/ads/nearblocks.png',
  },
  {
    id: 'meteor',
    name: 'Meteor Wallet',
    href: 'https://wallet.meteorwallet.app',
    logo: '/ads/meteor.png',
  },
  {
    id: 'here',
    name: 'HERE Wallet',
    href: 'https://herewallet.app',
    logo: '/ads/here.png',
  },
  {
    id: 'nearai',
    name: 'NEAR.ai',
    href: 'https://near.ai',
    logo: '/ads/nearai.png',
  },
];
