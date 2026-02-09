import * as path from 'node:path';
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { STATIC_CACHE_CONTROL, VERSIONED_CACHE_CONTROL } from '../constants';
import { getAssetCopyEntries } from '../manifest-reader';
import type { OpenNextManifest } from '../types';

export type AssetDeploymentProps = {
  readonly openNextPath: string;
  readonly manifest: OpenNextManifest;
  readonly bucket: s3.IBucket;
  readonly distribution: cloudfront.IDistribution;
};

/**
 * Deploys static asset files from the OpenNext build output into the S3
 * bucket based on the manifest's copy entries. Each entry gets its own
 * BucketDeployment with appropriate Cache-Control headers.
 *
 * The bucket itself is created by the orchestrator (so that revalidation,
 * server functions, and image optimization can reference it before the
 * distribution exists). This component only handles the file deployments.
 */
export class AssetDeployment extends Construct {
  public constructor(
    scope: Construct,
    id: string,
    props: AssetDeploymentProps,
  ) {
    super(scope, id);

    const copyEntries = getAssetCopyEntries(props.manifest);

    for (let i = 0; i < copyEntries.length; i++) {
      const entry = copyEntries[i];
      const sourcePath = path.join(props.openNextPath, entry.from);
      const destinationKeyPrefix =
        entry.to === '/' || entry.to === '' ? undefined : entry.to;

      // Use appropriate cache control based on whether assets are versioned
      const cacheControl = entry.cached
        ? s3deploy.CacheControl.fromString(VERSIONED_CACHE_CONTROL)
        : s3deploy.CacheControl.fromString(STATIC_CACHE_CONTROL);

      new s3deploy.BucketDeployment(this, `Deploy${i}`, {
        sources: [s3deploy.Source.asset(sourcePath)],
        destinationBucket: props.bucket,
        destinationKeyPrefix,
        cacheControl: [cacheControl],
        prune: false,
        distribution: props.distribution,
        distributionPaths: ['/*'],
      });
    }
  }
}
