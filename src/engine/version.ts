/**
 * Engine output version.
 * 1.1.0 records Wave 2.1: corrected SHA-256 identities and seed/version metadata;
 * explicit threshold-profile applicability gates; and data-derived quality, PCA,
 * target-tercile, PACF, and feature-association results. Removing unsupported EDA
 * proxies and changing these calculations can alter reported statistics and model
 * qualification decisions. Bump for any later numeric-method or gate-semantic change.
 */
export const ENGINE_VERSION = '1.1.0';
