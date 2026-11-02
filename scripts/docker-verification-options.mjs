import { resolve } from "node:path";

export function verificationOptions(args, root) {
  const options = { pull: false };
  const flags = { "--backend-image": "backendImage", "--frontend-image": "frontendImage", "--compose-file": "composeFile" };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--pull" && !options.pull) options.pull = true;
    else if (flags[flag] && !options[flags[flag]]) {
      const value = args[++index];
      if (!value || value.startsWith("-") || /[\s'\n]/.test(value)) throw new Error(`Invalid value for ${flag}`);
      options[flags[flag]] = value;
    } else throw new Error(`Unknown or repeated option: ${flag}`);
  }
  options.prebuilt = Boolean(options.backendImage || options.frontendImage);
  if (options.prebuilt && !(options.backendImage && options.frontendImage)) throw new Error("Both --backend-image and --frontend-image are required");
  if (!options.prebuilt && (options.pull || options.composeFile)) throw new Error("--pull and --compose-file require both prebuilt images");
  if (options.composeFile) options.composeFile = resolve(root, options.composeFile);
  return options;
}

export function verificationCleanupArgs(prebuilt) {
  return ["down", "--volumes", "--remove-orphans", ...(!prebuilt ? ["--rmi", "local"] : []), "--timeout", "20"];
}
