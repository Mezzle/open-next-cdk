import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import {
  TAG_CACHE_GSI_NAME,
  TAG_CACHE_GSI_PARTITION_KEY,
  TAG_CACHE_GSI_SORT_KEY,
  TAG_CACHE_PARTITION_KEY,
  TAG_CACHE_SORT_KEY,
} from '../constants';
import type { TagCacheOptions } from '../types';
import { resourceName } from '../utils';

export type TagCacheTableProps = {
  readonly prefix: string;
  readonly options?: TagCacheOptions;
};

/**
 * Creates a DynamoDB table for OpenNext v3 tag-based cache revalidation.
 * The table uses a composite key of (tag, path) with a GSI on (path, tag)
 * to support both tag-based and path-based lookups.
 */
export class TagCacheTable extends Construct {
  public readonly table?: dynamodb.ITable;

  public constructor(scope: Construct, id: string, props: TagCacheTableProps) {
    super(scope, id);

    if (props.options?.disabled) {
      return;
    }

    if (props.options?.existingTable) {
      this.table = props.options.existingTable;
      return;
    }

    const billingMode =
      props.options?.billingMode === 'PROVISIONED'
        ? dynamodb.BillingMode.PROVISIONED
        : dynamodb.BillingMode.PAY_PER_REQUEST;

    const table = new dynamodb.Table(this, 'Table', {
      tableName: resourceName(props.prefix, 'tag-cache'),
      partitionKey: {
        name: TAG_CACHE_PARTITION_KEY,
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: TAG_CACHE_SORT_KEY,
        type: dynamodb.AttributeType.STRING,
      },
      billingMode,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    table.addGlobalSecondaryIndex({
      indexName: TAG_CACHE_GSI_NAME,
      partitionKey: {
        name: TAG_CACHE_GSI_PARTITION_KEY,
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: TAG_CACHE_GSI_SORT_KEY,
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.table = table;
  }
}
