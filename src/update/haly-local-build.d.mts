export declare const HALY_LOCAL_BUILD_MARKER: string;
export declare const HALY_LOCAL_BUILD_UPDATE_REFUSAL: string;
export declare function isHalyLocalBuild(
  packageRoot: string,
  env?: Readonly<Record<string, string | undefined>>,
): boolean;
