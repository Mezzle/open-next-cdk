import { DEFAULT_PREFIX } from './constants';

/**
 * Create a resource name with a prefix and suffix.
 * e.g., resourceName('opennext', 'server') → 'opennext-server'
 */
export const resourceName = (
  prefix: string | undefined,
  suffix: string,
): string => {
  const p = prefix ?? DEFAULT_PREFIX;
  return `${p}-${suffix}`;
};

/**
 * Create a CloudFormation-compatible resource ID from a name.
 * Removes non-alphanumeric characters and capitalizes each word.
 * e.g., 'my-server-function' → 'MyServerFunction'
 */
export const toResourceId = (name: string): string =>
  name
    .split(/[-_.\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');

/**
 * Convert an origin key from the manifest into a safe resource name suffix.
 * e.g., 'api/trpc' → 'api-trpc'
 */
export const originKeyToSuffix = (originKey: string): string =>
  originKey
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
