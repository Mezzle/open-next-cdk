import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { WAF_MANAGED_RULE_GROUPS } from '../constants';
import type { WafOptions } from '../types';
import { resourceName } from '../utils';

export type WafProps = {
  readonly prefix: string;
  readonly options?: WafOptions;
};

/**
 * Creates a WAFv2 Web ACL for CloudFront with AWS managed rule groups.
 *
 * Note: WAF for CloudFront must be created in us-east-1. If the stack is
 * not in us-east-1, the user should pass an existingWebAclArn from a
 * cross-region stack.
 */
export class Waf extends Construct {
  public readonly webAclArn?: string;

  public constructor(scope: Construct, id: string, props: WafProps) {
    super(scope, id);

    const opts = props.options ?? {};

    // Disabled
    if (opts.enabled === false) {
      return;
    }

    // Use existing WAF
    if (opts.existingWebAclArn) {
      this.webAclArn = opts.existingWebAclArn;
      return;
    }

    // Build managed rule groups
    const rules: wafv2.CfnWebACL.RuleProperty[] = WAF_MANAGED_RULE_GROUPS.map(
      (ruleGroup) => ({
        name: ruleGroup.name,
        priority: ruleGroup.priority,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            name: ruleGroup.name,
            vendorName: ruleGroup.vendorName,
          },
        },
        visibilityConfig: {
          sampledRequestsEnabled: true,
          cloudWatchMetricsEnabled: true,
          metricName: `${resourceName(props.prefix, ruleGroup.name)}`,
        },
      }),
    );

    // Append additional user-provided rules
    if (opts.additionalRules) {
      rules.push(...opts.additionalRules);
    }

    const webAcl = new wafv2.CfnWebACL(this, 'WebACL', {
      name: resourceName(props.prefix, 'waf'),
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      rules,
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: resourceName(props.prefix, 'waf'),
      },
    });

    this.webAclArn = webAcl.attrArn;
  }
}
