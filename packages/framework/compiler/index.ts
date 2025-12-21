import path from 'node:path';
import { Command } from 'commander';
import fs from 'fs-extra';
import { Generator } from './generator';
import { Packager } from './packager';
import { Splitter } from './splitter';
import { Validator } from './validator';

const program = new Command();

program
  .name('knative-next-compiler')
  .description('Compiles Next.js application for Knative deployment')
  .version('0.1.0')
  .requiredOption('-i, --image <image>', 'Docker image name for the runtime')
  .option('-d, --dir <dir>', 'Path to Next.js project root', '.')
  .option('-o, --output <output>', 'Output directory for YAMLs', './knative-manifests')
  .option('-n, --namespace <namespace>', 'Kubernetes namespace', 'default')
  .action(async (options) => {
    try {
      const projectDir = path.resolve(options.dir);
      const nextDir = path.resolve(projectDir, '.next');
      const outputDir = path.resolve(options.output);
      const validator = new Validator(projectDir);
      await validator.validate();
      const splitter = new Splitter(nextDir);
      const groups = await splitter.analyze();

      // Load config
      const configPath = path.join(projectDir, 'knative-next.config.json');
      let envConfig = {};
      if (await fs.pathExists(configPath)) {
        const config = await fs.readJSON(configPath);
        envConfig = config.env || {};
      }

      // Package each group
      const packager = new Packager(projectDir, outputDir, options.image);
      const groupImages: Record<string, string> = {};

      for (const group of groups) {
        const imageName = await packager.package(group);
        groupImages[group.name] = imageName;
      }

      const generator = new Generator(
        outputDir,
        options.image,
        options.namespace,
        envConfig,
        options.dir,
      );
      await generator.generate(groups, groupImages);
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

program.parse();
