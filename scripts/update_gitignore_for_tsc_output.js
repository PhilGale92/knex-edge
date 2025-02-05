#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

// Directory constants
const scriptDirectory = __dirname;
const repoDirectory = path.join(scriptDirectory, '..');
const libDirectory = path.join(repoDirectory, 'lib');

const helpText = `
Helper script to update lib/.gitignore for all .js files from .ts files.

    update_gitignore_for_tsc_output.js COMMAND

    COMMAND:
        run:  Update lib/.gitignore file.
        help: Print this menu.

    NOTES FOR USAGE:
    1. This script is tested to work on Ubuntu 18.04 LTS.
`;

const gitignoreHeader = `# DO NOT EDIT, GENERATED BY: scripts/update_gitignore_for_tsc_output.js

# Do not include tsc generated type definitions
**/*.d.ts

# Do not include tsc source maps
**/*.js.map

# Do not include .js files from .ts files
`;

function main(cliCommand) {
  if (cliCommand === 'run') {
    console.log('Generating lib/.gitignore ...');

    // Find all .ts files in lib/
    const directoriesToProcess = [libDirectory];
    const tsFiles = [];
    while (directoriesToProcess.length > 0) {
      const directory = directoriesToProcess.pop();
      if (!fs.existsSync(directory)) {
        throw new Error("Directory doesn't exist:", directory);
      }

      const files = fs.readdirSync(directory);
      files.forEach((file) => {
        const filename = path.join(directory, file);
        const stat = fs.lstatSync(filename);
        if (stat.isDirectory()) {
          directoriesToProcess.push(filename);
        } else if (filename.endsWith('.ts') && !filename.endsWith('.d.ts')) {
          tsFiles.push(filename);
          console.log('Found .ts file:', filename);
        }
      });
    }

    // Get paths of .js files to ignore
    const jsFilesToIgnore = tsFiles.map((filepath) => {
      // Cuts off `${libDirectory}/`
      const relativeTsPath = filepath.slice(libDirectory.length + 1);
      // Swaps .ts for .js file ending
      const relativeJsPath =
        relativeTsPath.slice(0, relativeTsPath.length - 3) + '.js';
      // Always use POSIX-style path separators - .gitignore requires it
      return relativeJsPath.split(path.sep).join(path.posix.sep);
    });
    // TODO - disabled as it was wiping out the dialect file which is the only one there
    // const jsFilesToIgnoreString = jsFilesToIgnore.join('\n');
    const jsFilesToIgnoreString = '';
    const libGitignorePath = path.join(libDirectory, '.gitignore');
    fs.writeFileSync(
      libGitignorePath,
      gitignoreHeader + jsFilesToIgnoreString + '\n'
    );
    console.log('DONE');
  } else if (['help', '--help', '-h', undefined].includes(cliCommand)) {
    console.log(helpText);
  } else {
    console.log(`Unsupported command: ${cliCommand}`);
    console.log("Try running with 'help' to see supported commands.");
    process.exit(1);
  }
}

// Main script logic
const cliCommand = process.argv[2];
// Start the bash app's main function
main(cliCommand);
