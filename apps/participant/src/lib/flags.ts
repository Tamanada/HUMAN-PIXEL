/**
 * Windows has no flag emoji font: country flags would render as letters ("FR"). This loads a
 * small self-hosted flag-only font (Twemoji, unicode-range limited) only where needed.
 */
import { polyfillCountryFlagEmojis } from 'country-flag-emoji-polyfill';
import flagFontUrl from 'country-flag-emoji-polyfill/dist/TwemojiCountryFlags.woff2?url';

export function installFlagFont(): void {
  try {
    polyfillCountryFlagEmojis('Twemoji Country Flags', flagFontUrl);
  } catch {
    /* canvas unavailable: letters remain readable */
  }
}
