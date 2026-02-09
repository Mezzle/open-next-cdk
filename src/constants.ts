/**
 * Default values for the OpenNextCdk construct.
 */

export const DEFAULT_PREFIX = 'opennext';

// ─── Lambda Defaults ─────────────────────────────────────────────────────────

export const DEFAULT_SERVER_MEMORY_SIZE = 1024;
export const DEFAULT_SERVER_TIMEOUT_SECONDS = 30;

export const DEFAULT_IMAGE_OPTIMIZATION_MEMORY_SIZE = 512;
export const DEFAULT_IMAGE_OPTIMIZATION_TIMEOUT_SECONDS = 30;

export const DEFAULT_REVALIDATION_MEMORY_SIZE = 256;
export const DEFAULT_REVALIDATION_TIMEOUT_SECONDS = 30;

export const DEFAULT_WARMER_MEMORY_SIZE = 256;
export const DEFAULT_WARMER_TIMEOUT_SECONDS = 30;

export const DEFAULT_LOG_FORWARDER_MEMORY_SIZE = 256;
export const DEFAULT_LOG_FORWARDER_TIMEOUT_SECONDS = 30;

export const DEFAULT_LAMBDA_ARCHITECTURE = 'arm64';
export const DEFAULT_LAMBDA_RUNTIME = 'nodejs20.x';
export const DEFAULT_LOG_RETENTION_DAYS = 30;

export const DEFAULT_SEEDER_MEMORY_SIZE = 256;
export const DEFAULT_SEEDER_TIMEOUT_SECONDS = 300; // Batch writes can be slow

// ─── CloudFront / Cache Defaults ─────────────────────────────────────────────

export const DEFAULT_CACHE_DEFAULT_TTL_SECONDS = 0;
export const DEFAULT_CACHE_MAX_TTL_SECONDS = 31536000; // 1 year
export const DEFAULT_CACHE_MIN_TTL_SECONDS = 0;

export const DEFAULT_HSTS_MAX_AGE = 63072000; // 2 years

/**
 * Next.js-specific headers to include in the CloudFront cache key.
 */
export const NEXT_CACHE_KEY_HEADERS = [
  'rsc',
  'next-router-prefetch',
  'next-router-state-tree',
  'x-prerender-revalidate',
  'next-url',
];

export const DEFAULT_PRICE_CLASS = 'PriceClass_100';

// ─── S3 Defaults ─────────────────────────────────────────────────────────────

/**
 * Cache-Control header for versioned assets (e.g., _next/static/).
 * Immutable, 1 year max-age.
 */
export const VERSIONED_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Cache-Control header for non-versioned static assets.
 * Short max-age with revalidation.
 */
export const STATIC_CACHE_CONTROL =
  'public, max-age=0, s-maxage=31536000, must-revalidate';

// ─── Warmer Defaults ─────────────────────────────────────────────────────────

export const DEFAULT_WARMER_SCHEDULE = 'rate(5 minutes)';
export const DEFAULT_WARMER_CONCURRENCY = 1;

// ─── WAF Managed Rule Groups ────────────────────────────────────────────────

export const WAF_MANAGED_RULE_GROUPS = [
  { name: 'AWSManagedRulesCommonRuleSet', vendorName: 'AWS', priority: 10 },
  {
    name: 'AWSManagedRulesKnownBadInputsRuleSet',
    vendorName: 'AWS',
    priority: 20,
  },
  { name: 'AWSManagedRulesLinuxRuleSet', vendorName: 'AWS', priority: 30 },
  { name: 'AWSManagedRulesUnixRuleSet', vendorName: 'AWS', priority: 40 },
];

// ─── DynamoDB Tag Cache ──────────────────────────────────────────────────────

export const TAG_CACHE_PARTITION_KEY = 'tag';
export const TAG_CACHE_SORT_KEY = 'path';
export const TAG_CACHE_GSI_NAME = 'revalidate';
export const TAG_CACHE_GSI_PARTITION_KEY = 'path';
export const TAG_CACHE_GSI_SORT_KEY = 'tag';
