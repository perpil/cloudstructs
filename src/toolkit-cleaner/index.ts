import * as path from 'path';
import { Duration } from 'aws-cdk-lib';
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { SfnStateMachine } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { CleanImagesFunction } from './clean-images-function';
import { CleanObjectsFunction } from './clean-objects-function';
import { ExtractTemplateHashesFunction } from './extract-template-hashes-function';
import { GetStackNamesFunction } from './get-stack-names-function';

/**
 * Properties for a ToolkitCleaner
 */
export interface ToolkitCleanerProps {
  /**
   * The schedule for the cleaner.
   *
   * @default - every day
   */
  readonly schedule?: Schedule;

  /**
   * Whether to clean on schedule. If you'd like to run the cleanup manually
   * via the console, set to `false`.
   *
   * @default true
   */
  readonly scheduleEnabled?: boolean;

  /**
   * Only output number of assets and total size that would be deleted
   * but without actually deleting assets.
   */
  readonly dryRun?: boolean;

  /**
   * Retain unused assets that were created recently
   *
   * @default - all unused assets are removed
   */
  readonly retainAssetsNewerThan?: Duration;

  /**
   * The timeout for the Lambda functions that clean assets
   *
   * @default Duration.minutes(5)
   */
  readonly cleanAssetsTimeout?: Duration;

  /**
   * Whether to clean ECR assets. If set to `false`, only S3 assets will be cleaned. If omitted or set to true, both S3 and ECR assets will be cleaned and Docker must be installed and running.
   *
   * @default true
   */
  readonly cleanEcrAssets?: boolean;
}

/**
 * Clean unused S3 and ECR assets from your CDK Toolkit.
 */
export class ToolkitCleaner extends Construct {
  constructor(scope: Construct, id: string, props: ToolkitCleanerProps = {}) {
    super(scope, id);

    const cleanEcrAssets = props.cleanEcrAssets ?? true;
    let retainMilliseconds;
    if (props.retainAssetsNewerThan) {
      retainMilliseconds = props.retainAssetsNewerThan.toMilliseconds().toString();
    }

    // Dummy assets to reference S3 bucket and ECR repository
    const fileAsset = new Asset(this, 'FileAsset', {
      path: path.join(__dirname, '..', '..', 'assets', 'toolkit-cleaner', 'docker', 'dummy.txt'),
    });

    const getStackNamesFunction = new GetStackNamesFunction(this, 'GetStackNamesFunction', {
      timeout: Duration.seconds(30),
    });
    getStackNamesFunction.addToRolePolicy(new PolicyStatement({
      actions: ['cloudformation:DescribeStacks', 'cloudformation:ListStacks'],
      resources: ['*'],
    }));

    const getStackNames = new tasks.LambdaInvoke(this, 'GetStackNames', {
      lambdaFunction: getStackNamesFunction,
      payloadResponseOnly: true,
    });

    const stacksMap = new sfn.Map(this, 'StacksMap', {
      maxConcurrency: 1, // Avoid "Rate exceeded" error from CloudFormation
      resultSelector: {
        AssetHashes: sfn.JsonPath.stringAt('$'),
      },
    });

    let cleanImages: tasks.LambdaInvoke, dockerImageAsset: DockerImageAsset;
    if (cleanEcrAssets) {
      dockerImageAsset = new DockerImageAsset(this, 'DockerImageAsset', {
        directory: path.join(__dirname, '..', '..', 'assets', 'toolkit-cleaner', 'docker'),
      });

      const cleanImagesFunction = new CleanImagesFunction(this, 'CleanImagesFunction', {
        timeout: props.cleanAssetsTimeout ?? Duration.minutes(5),
      });
      cleanImagesFunction.addEnvironment('REPOSITORY_NAME', dockerImageAsset.repository.repositoryName);
      dockerImageAsset.repository.grant(cleanImagesFunction, 'ecr:DescribeImages', 'ecr:BatchDeleteImage');
      cleanImages = new tasks.LambdaInvoke(this, 'CleanImages', {
        lambdaFunction: cleanImagesFunction,
        payloadResponseOnly: true,
      });
      if (!props.dryRun) {
        cleanImagesFunction.addEnvironment('RUN', 'true');
      }

      if (retainMilliseconds) {
        cleanImagesFunction.addEnvironment('RETAIN_MILLISECONDS', retainMilliseconds);
      }
    }

    const cleanObjectsFunction = new CleanObjectsFunction(this, 'CleanObjectsFunction', {
      timeout: props.cleanAssetsTimeout ?? Duration.minutes(5),
    });
    cleanObjectsFunction.addEnvironment('BUCKET_NAME', fileAsset.bucket.bucketName);
    fileAsset.bucket.grantRead(cleanObjectsFunction);
    fileAsset.bucket.grantDelete(cleanObjectsFunction);
    const cleanObjects = new tasks.LambdaInvoke(this, 'CleanObjects', {
      lambdaFunction: cleanObjectsFunction,
      payloadResponseOnly: true,
    });

    if (!props.dryRun) {
      cleanObjectsFunction.addEnvironment('RUN', 'true');
    }

    if (retainMilliseconds) {
      cleanObjectsFunction.addEnvironment('RETAIN_MILLISECONDS', retainMilliseconds);
    }

    const sumReclaimed = new tasks.EvaluateExpression(this, 'SumReclaimed', {
      expression: cleanEcrAssets ?
        '({ Deleted: $[0].Deleted + $[1].Deleted, Reclaimed: $[0].Reclaimed + $[1].Reclaimed })':'({ Deleted: $[0].Deleted, Reclaimed: $[0].Reclaimed})',
    });

    const extractTemplateHashesFunction = new ExtractTemplateHashesFunction(this, 'ExtractTemplateHashesFunction', {
      timeout: Duration.seconds(30),
      environment: {
        DOCKER_IMAGE_ASSET_HASH: cleanEcrAssets ? dockerImageAsset!.assetHash : ' ',
      },
    });
    extractTemplateHashesFunction.addToRolePolicy(new PolicyStatement({
      actions: ['cloudformation:GetTemplate'],
      resources: ['*'],
    }));
    const extractTemplateHashes = new tasks.LambdaInvoke(this, 'ExtractTemplateHashes', {
      lambdaFunction: extractTemplateHashesFunction,
      payloadResponseOnly: true,
    }).addRetry({
      errors: ['Throttling'], // Avoid "Rate exceeded" error from CloudFormation
    });

    const flattenHashes = new tasks.EvaluateExpression(this, 'FlattenHashes', {
      expression: '[...new Set(($.AssetHashes).flat())]',
    });

    const stateMachineDefinition = getStackNames
      .next(stacksMap.itemProcessor(extractTemplateHashes))
      .next(flattenHashes);

    if (cleanEcrAssets) {
      stateMachineDefinition.next(new sfn.Parallel(this, 'Clean')
        .branch(cleanObjects)
        .branch(cleanImages!))
        .next(sumReclaimed);
    } else {
      stateMachineDefinition.next(cleanObjects)
        .next(sumReclaimed);
    }

    const stateMachine = new sfn.StateMachine(this, 'Resource', {
      definitionBody: sfn.DefinitionBody.fromChainable(
        stateMachineDefinition,
      ),
    });

    const rule = new Rule(this, 'Rule', {
      enabled: props.scheduleEnabled ?? true,
      schedule: props.schedule ?? Schedule.rate(Duration.days(1)),
    });
    rule.addTarget(new SfnStateMachine(stateMachine));
  }
}
