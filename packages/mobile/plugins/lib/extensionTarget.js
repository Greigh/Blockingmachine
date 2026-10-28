// @ts-check
/**
 * Generic app-extension wiring shared by `withDnsProxyTarget` and
 * `withTunnelTarget`. An extension is a real second binary (.appex embedded
 * in PlugIns); canonical sources live in `targets/<name>/` so
 * `expo prebuild --clean` can regenerate `ios/`. The helper copies them in
 * and performs the pbxproj surgery by hand (PBXFileReference/PBXBuildFile,
 * source/frameworks/resources phases, the native target + its
 * XCConfigurationList, the product reference, the "Embed App Extensions"
 * copy phase, and the app→appex target dependency).
 *
 * `opts`:
 *   targetName      — PBX target + directory name under `targets/`
 *   extBundleId     — PRODUCT_BUNDLE_IDENTIFIER for the appex
 *   appGroup        — shared container id both targets sign for
 *   swiftFiles      — compiled sources inside the target dir
 *   entitlement     — `com.apple.developer.networking.networkextension` value
 *   extraSrcDirs    — extra `targets/` dirs whose files compile into this
 *                     target too (shared sources such as DnsPacket/Blocklist)
 */
const path = require('path');
const fs = require('fs');
const {
  withXcodeProject,
  withEntitlementsPlist,
  withDangerousMod,
} = require('@expo/config-plugins');

/** Copy the canonical extension sources into the generated ios/ tree. */
function copySources(config, { targetName, extraSrcDirs = [] }) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const targetsRoot = path.join(cfg.modRequest.projectRoot, 'targets');
      const dst = path.join(cfg.modRequest.platformProjectRoot, targetName);
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(path.join(targetsRoot, targetName), dst, { recursive: true });
      // Shared sources (e.g. targets/BlockingmachineDNSProxy's DnsPacket.swift
      // and Blocklist.swift) land beside the target's own — same target dir.
      for (const { dir, files } of extraSrcDirs) {
        for (const name of files) {
          fs.copyFileSync(path.join(targetsRoot, dir, name), path.join(dst, name));
        }
      }
      return cfg;
    },
  ]);
}

/** Merge the app-side entitlements the manager + app group need. */
function withAppEntitlements(config, { appGroup, entitlement }) {
  return withEntitlementsPlist(config, (cfg) => {
    const mod = cfg.modResults;
    const ne = mod['com.apple.developer.networking.networkextension'];
    if (!Array.isArray(ne)) {
      mod['com.apple.developer.networking.networkextension'] = [entitlement];
    } else if (!ne.includes(entitlement)) {
      ne.push(entitlement);
    }
    const groups = mod['com.apple.security.application-groups'];
    if (!Array.isArray(groups)) {
      mod['com.apple.security.application-groups'] = [appGroup];
    } else if (!groups.includes(appGroup)) {
      groups.push(appGroup);
    }
    return cfg;
  });
}

function buildSettings(kind, { targetName, extBundleId }) {
  const base = {
    ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES: 'YES',
    APPLICATION_EXTENSION_API_ONLY: 'YES',
    CLANG_ENABLE_MODULES: 'YES',
    CODE_SIGN_ENTITLEMENTS: `${targetName}/${targetName}.entitlements`,
    CODE_SIGN_STYLE: 'Automatic',
    CURRENT_PROJECT_VERSION: '1',
    GENERATE_INFOPLIST_FILE: 'NO',
    INFOPLIST_FILE: `${targetName}/Info.plist`,
    IPHONEOS_DEPLOYMENT_TARGET: '16.4',
    LD_RUNPATH_SEARCH_PATHS:
      '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"',
    MARKETING_VERSION: '1.0',
    PRODUCT_BUNDLE_IDENTIFIER: extBundleId,
    PRODUCT_BUNDLE_PACKAGE_TYPE: '"XPC!"',
    PRODUCT_NAME: '"$(TARGET_NAME)"',
    SDKROOT: 'iphoneos',
    SKIP_INSTALL: 'YES',
    SWIFT_EMIT_LOC_STRINGS: 'YES',
    SWIFT_VERSION: '5.0',
    TARGETED_DEVICE_FAMILY: '"1,2"',
  };
  return kind === 'Debug'
    ? {
        ...base,
        MTL_ENABLE_DEBUG_INFO: 'INCLUDE_SOURCE',
        SWIFT_OPTIMIZATION_LEVEL: '"-Onone"',
        SWIFT_ACTIVE_COMPILATION_CONDITIONS: '"$(inherited) DEBUG"',
      }
    : { ...base, MTL_ENABLE_DEBUG_INFO: 'NO' };
}

/** All pbxproj wiring, guarded so a second prebuild run is a no-op. */
function addExtensionTarget(proj, { targetName, extBundleId, swiftFiles, metaFiles }) {
  if (proj.pbxTargetByName(targetName)) return;

  const objs = proj.hash.project.objects;
  const uuid = () => proj.generateUuid();

  const groupUuid = uuid();
  const sourcesPhaseUuid = uuid();
  const frameworksPhaseUuid = uuid();
  const resourcesPhaseUuid = uuid();
  const targetUuid = uuid();
  const configListUuid = uuid();
  const productRefUuid = uuid();
  const embedPhaseUuid = uuid();
  const embedBuildFileUuid = uuid();
  const proxyUuid = uuid();
  const depUuid = uuid();

  const groupChildren = [];
  const sourceFiles = [];

  // File references: swift sources get PBXBuildFile entries + Sources phase
  // membership; plist/entitlements are referenced only (never compiled).
  for (const name of swiftFiles) {
    const fileRef = uuid();
    const buildFile = uuid();
    objs.PBXFileReference[fileRef] = {
      isa: 'PBXFileReference',
      lastKnownFileType: 'sourcecode.swift',
      name: `"${name}"`,
      path: `"${name}"`,
      sourceTree: '"<group>"',
    };
    objs.PBXFileReference[`${fileRef}_comment`] = name;
    objs.PBXBuildFile[buildFile] = {
      isa: 'PBXBuildFile',
      fileRef,
      fileRef_comment: name,
    };
    objs.PBXBuildFile[`${buildFile}_comment`] = `${name} in Sources`;
    sourceFiles.push({ value: buildFile, comment: `${name} in Sources` });
    groupChildren.push({ value: fileRef, comment: name });
  }
  for (const name of metaFiles) {
    const fileRef = uuid();
    objs.PBXFileReference[fileRef] = {
      isa: 'PBXFileReference',
      lastKnownFileType: 'text.plist.xml',
      name: `"${name}"`,
      path: `"${name}"`,
      sourceTree: '"<group>"',
    };
    objs.PBXFileReference[`${fileRef}_comment`] = name;
    groupChildren.push({ value: fileRef, comment: name });
  }

  // Source group under the project root group.
  objs.PBXGroup[groupUuid] = {
    isa: 'PBXGroup',
    children: groupChildren,
    name: `"${targetName}"`,
    path: `"${targetName}"`,
    sourceTree: '"<group>"',
  };
  objs.PBXGroup[`${groupUuid}_comment`] = targetName;
  const rootUuid = proj.getFirstProject().uuid;
  const projectObj = objs.PBXProject[rootUuid];
  const mainGroupRef = projectObj.mainGroup;
  const mainGroup = objs.PBXGroup[mainGroupRef];
  mainGroup.children.push({ value: groupUuid, comment: targetName });

  // Build phases.
  objs.PBXSourcesBuildPhase[sourcesPhaseUuid] = {
    isa: 'PBXSourcesBuildPhase',
    buildActionMask: 2147483647,
    files: sourceFiles,
    runOnlyForDeploymentPostprocessing: 0,
  };
  objs.PBXFrameworksBuildPhase[frameworksPhaseUuid] = {
    isa: 'PBXFrameworksBuildPhase',
    buildActionMask: 2147483647,
    files: [],
    runOnlyForDeploymentPostprocessing: 0,
  };
  objs.PBXResourcesBuildPhase[resourcesPhaseUuid] = {
    isa: 'PBXResourcesBuildPhase',
    buildActionMask: 2147483647,
    files: [],
    runOnlyForDeploymentPostprocessing: 0,
  };

  // Product reference (the .appex) into the Products group.
  objs.PBXFileReference[productRefUuid] = {
    isa: 'PBXFileReference',
    explicitFileType: '"wrapper.app-extension"',
    path: `"${targetName}.appex"`,
    sourceTree: 'BUILT_PRODUCTS_DIR',
  };
  const products = proj.pbxGroupByName('Products');
  products.children.push({ value: productRefUuid, comment: `${targetName}.appex` });

  // Debug/Release build configurations + the list.
  const debugUuid = uuid();
  const releaseUuid = uuid();
  objs.XCBuildConfiguration[debugUuid] = {
    isa: 'XCBuildConfiguration',
    buildSettings: buildSettings('Debug', { targetName, extBundleId }),
    name: 'Debug',
  };
  objs.XCBuildConfiguration[`${debugUuid}_comment`] = 'Debug';
  objs.XCBuildConfiguration[releaseUuid] = {
    isa: 'XCBuildConfiguration',
    buildSettings: buildSettings('Release', { targetName, extBundleId }),
    name: 'Release',
  };
  objs.XCBuildConfiguration[`${releaseUuid}_comment`] = 'Release';
  objs.XCConfigurationList[configListUuid] = {
    isa: 'XCConfigurationList',
    buildConfigurations: [
      { value: debugUuid, comment: 'Debug' },
      { value: releaseUuid, comment: 'Release' },
    ],
    defaultConfigurationIsVisible: 0,
    defaultConfigurationName: 'Release',
  };
  objs.XCConfigurationList[`${configListUuid}_comment`] =
    `Build configuration list for PBXNativeTarget "${targetName}"`;

  // The native target itself.
  objs.PBXNativeTarget[targetUuid] = {
    isa: 'PBXNativeTarget',
    buildConfigurationList: configListUuid,
    buildConfigurationList_comment: `Build configuration list for PBXNativeTarget "${targetName}"`,
    buildPhases: [
      { value: sourcesPhaseUuid, comment: 'Sources' },
      { value: frameworksPhaseUuid, comment: 'Frameworks' },
      { value: resourcesPhaseUuid, comment: 'Resources' },
    ],
    buildRules: [],
    dependencies: [],
    name: targetName,
    productName: targetName,
    productReference: productRefUuid,
    productReference_comment: `${targetName}.appex`,
    productType: '"com.apple.product-type.app-extension"',
  };
  objs.PBXNativeTarget[`${targetUuid}_comment`] = targetName;

  // "Embed App Extensions" copy phase on the app target (dstSubfolderSpec 13 = PlugIns).
  objs.PBXCopyFilesBuildPhase = objs.PBXCopyFilesBuildPhase || {};
  objs.PBXBuildFile[embedBuildFileUuid] = {
    isa: 'PBXBuildFile',
    fileRef: productRefUuid,
    fileRef_comment: `${targetName}.appex`,
    settings: { ATTRIBUTES: ['RemoveHeadersOnCopy'] },
  };
  objs.PBXBuildFile[`${embedBuildFileUuid}_comment`] = `${targetName}.appex in Embed App Extensions`;
  objs.PBXCopyFilesBuildPhase[embedPhaseUuid] = {
    isa: 'PBXCopyFilesBuildPhase',
    buildActionMask: 2147483647,
    dstPath: '""',
    dstSubfolderSpec: 13,
    files: [{ value: embedBuildFileUuid, comment: `${targetName}.appex in Embed App Extensions` }],
    name: '"Embed App Extensions"',
    runOnlyForDeploymentPostprocessing: 0,
  };

  // App target: embed phase + dependency on the extension target.
  const appTarget = proj.pbxTargetByName('Blockingmachine');
  appTarget.buildPhases.push({ value: embedPhaseUuid, comment: 'Embed App Extensions' });
  objs.PBXContainerItemProxy = objs.PBXContainerItemProxy || {};
  objs.PBXContainerItemProxy[proxyUuid] = {
    isa: 'PBXContainerItemProxy',
    containerPortal: rootUuid,
    containerPortal_comment: 'Project object',
    proxyType: 1,
    remoteGlobalIDString: targetUuid,
    remoteInfo: `"${targetName}"`,
  };
  objs.PBXTargetDependency = objs.PBXTargetDependency || {};
  objs.PBXTargetDependency[depUuid] = {
    isa: 'PBXTargetDependency',
    target: targetUuid,
    target_comment: targetName,
    targetProxy: proxyUuid,
    targetProxy_comment: `PBXContainerItemProxy`,
  };
  appTarget.dependencies = appTarget.dependencies || [];
  appTarget.dependencies.push({ value: depUuid, comment: `PBXTargetDependency` });

  // Register with the project: target list + TargetAttributes.
  projectObj.targets.push({ value: targetUuid, comment: targetName });
  projectObj.attributes = projectObj.attributes || {};
  projectObj.attributes.TargetAttributes = projectObj.attributes.TargetAttributes || {};
  projectObj.attributes.TargetAttributes[targetUuid] = {
    CreatedOnToolsVersion: '16.0',
    LastSwiftMigration: '1600',
  };
}

/**
 * Compose the plugin body: entitlements → source copy (+ shared dirs) →
 * pbxproj wiring. Both extension plugins call this with their own constants.
 * @param {import('@expo/config-plugins').ExportedConfig} config
 */
function apply(config, opts) {
  const swiftFiles = [
    ...opts.swiftFiles,
    ...(opts.extraSrcDirs || []).flatMap((d) => d.files),
  ];
  const metaFiles = ['Info.plist', `${opts.targetName}.entitlements`];
  config = withAppEntitlements(config, opts);
  config = copySources(config, opts);
  config = withXcodeProject(config, (cfg) => {
    addExtensionTarget(cfg.modResults, { ...opts, swiftFiles, metaFiles });
    return cfg;
  });
  return config;
}

module.exports = { apply };
