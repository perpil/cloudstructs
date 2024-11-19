import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * Props for ExtractTemplateHashesFunction
 */
export interface ExtractTemplateHashesFunctionProps extends lambda.FunctionOptions {
  /**
   * Whether to clean ECR assets.
   *
   * @default true
   */
  readonly cleanEcrAssets?: boolean;
}

/**
 * An AWS Lambda function which executes src/toolkit-cleaner/extract-template-hashes.
 */
export class ExtractTemplateHashesFunction extends lambda.Function {
  constructor(scope: Construct, id: string, props?: ExtractTemplateHashesFunctionProps) {
    super(scope, id, {
      description: 'src/toolkit-cleaner/extract-template-hashes.lambda.ts',
      ...props,
      runtime: new lambda.Runtime('nodejs20.x', lambda.RuntimeFamily.NODEJS),
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../assets/toolkit-cleaner/extract-template-hashes.lambda')),
    });

    if (props?.cleanEcrAssets !== false) {
      this.addEnvironment('DOCKER_IMAGE_ASSET_HASH', 'dummy-hash');
    }

    this.addEnvironment('AWS_NODEJS_CONNECTION_REUSE_ENABLED', '1', { removeInEdge: true });
  }
}
