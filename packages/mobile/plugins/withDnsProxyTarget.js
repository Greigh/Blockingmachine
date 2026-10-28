// @ts-check
/**
 * Wires the `NEDNSProxyProvider` app extension into the iOS project. The
 * extension is a real second binary (.appex embedded in PlugIns) — the only
 * way iOS permits device-wide DNS filtering without a VPN tunnel. Canonical
 * sources live in `targets/BlockingmachineDNSProxy/` so `expo prebuild --clean`
 * can regenerate `ios/`; this plugin copies them in and performs the pbxproj
 * surgery by hand (PBXFileReference/PBXBuildFile, source/frameworks/resources
 * phases, the native target + its XCConfigurationList, the product reference,
 * the "Embed App Extensions" copy phase, and the app→appex target dependency).
 *
 * Entitlement notes: the app itself needs `networkextension`/`dns-proxy` to
 * drive NEDNSProxyManager, and both targets share `group.com.blockingmachine.mobile`
 * so `ruleset_native.txt` reaches the extension. On-device signing still
 * requires the Network Extensions capability on the App ID — see the README.
 */
const path = require('path');
const fs = require('fs');
const {
  withXcodeProject,
  withEntitlementsPlist,
  withDangerousMod,
} = require('@expo/config-plugins');
const xcode = require('xcode');
const pbxFile = require('xcode/lib/pbxFile');

const TARGET_NAME = 'BlockingmachineDNSProxy';
const EXT_BUNDLE_ID = 'com.greighstudios.blockingmachine.dnsproxy';
const APP_GROUP = 'group.com.greighstudios.blockingmachine';
const SWIFT_FILES = ['DnsPacket.swift', 'Blocklist.swift', 'DNSProxyProvider.swift'];
const META_FILES = ['Info.plist', `${TARGET_NAME}.entitlements`];

/** Copy the canonical extension sources into the generated ios/ tree. */
function copySources(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, 'targets', TARGET_NAME);
      const dst = path.join(cfg.modRequest.platformProjectRoot, TARGET_NAME);
      fs.rmSync(dst, { recursive: true, force: true });
      fs.cpSync(src, dst, { recursive: true });
      return cfg;
    },
  ]);
}

/** Merge the app-side entitlements the manager + app group need. */
function withAppEntitlements(config) {
  return withEntitlementsPlist(config, (cfg) => {
    const mod = cfg.modResults;
    const ne = mod['com.apple.developer.networking.networkextension'];
    if (!Array.isArray(ne)) {
      mod['com.apple.developer.networking.networkextension'] = ['dns-proxy'];
    } else if (!ne.includes('dns-proxy')) {
      ne.push('dns-proxy');
    }
    const groups = mod['com.apple.security.application-groups'];
    if (!Array.isArray(groups)) {
      mod['com.apple.security.application-groups'] = [APP_GROUP];
    } else if (!groups.includes(APP_GROUP)) {
      groups.push(APP_GROUP);
    }
    return cfg;
  });
}

function buildSettings(kind) {
  const base = {
    ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES: 'YES',
    APPLICATION_EXTENSION_API_ONLY: 'YES',
    CLANG_ENABLE_MODULES: 'YES',
    CODE_SIGN_ENTITLEMENTS: `${TARGET_NAME}/${TARGET_NAME}.entitlements`,
    CODE_SIGN_STYLE: 'Automatic',
    CURRENT_PROJECT_VERSION: '1',
    GENERATE_INFOPLIST_FILE: 'NO',
    INFOPLIST_FILE: `${TARGET_NAME}/Info.plist`,
    IPHONEOS_DEPLOYMENT_TARGET: '16.4',
    LD_RUNPATH_SEARCH_PATHS:
      '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"',
    MARKETING_VERSION: '1.0',
    PRODUCT_BUNDLE_IDENTIFIER: EXT_BUNDLE_ID,
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
function addExtensionTarget(proj) {
  if (proj.pbxTargetByName(TARGET_NAME)) return;

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
  for (const name of SWIFT_FILES) {
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
  for (const name of META_FILES) {
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
    name: `"${TARGET_NAME}"`,
    path: `"${TARGET_NAME}"`,
    sourceTree: '"<group>"',
  };
  objs.PBXGroup[`${groupUuid}_comment`] = TARGET_NAME;
  const rootUuid = proj.getFirstProject().uuid;
  const projectObj = objs.PBXProject[rootUuid];
  const mainGroupRef = projectObj.mainGroup;
  const mainGroup = objs.PBXGroup[mainGroupRef];
  mainGroup.children.push({ value: groupUuid, comment: TARGET_NAME });

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
    path: `"${TARGET_NAME}.appex"`,
    sourceTree: 'BUILT_PRODUCTS_DIR',
  };
  const products = proj.pbxGroupByName('Products');
  products.children.push({ value: productRefUuid, comment: `${TARGET_NAME}.appex` });

  // Debug/Release build configurations + the list.
  const debugUuid = uuid();
  const releaseUuid = uuid();
  objs.XCBuildConfiguration[debugUuid] = {
    isa: 'XCBuildConfiguration',
    buildSettings: buildSettings('Debug'),
    name: 'Debug',
  };
  objs.XCBuildConfiguration[`${debugUuid}_comment`] = 'Debug';
  objs.XCBuildConfiguration[releaseUuid] = {
    isa: 'XCBuildConfiguration',
    buildSettings: buildSettings('Release'),
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
    `Build configuration list for PBXNativeTarget "${TARGET_NAME}"`;

  // The native target itself.
  objs.PBXNativeTarget[targetUuid] = {
    isa: 'PBXNativeTarget',
    buildConfigurationList: configListUuid,
    buildConfigurationList_comment: `Build configuration list for PBXNativeTarget "${TARGET_NAME}"`,
    buildPhases: [
      { value: sourcesPhaseUuid, comment: 'Sources' },
      { value: frameworksPhaseUuid, comment: 'Frameworks' },
      { value: resourcesPhaseUuid, comment: 'Resources' },
    ],
    buildRules: [],
    dependencies: [],
    name: TARGET_NAME,
    productName: TARGET_NAME,
    productReference: productRefUuid,
    productReference_comment: `${TARGET_NAME}.appex`,
    productType: '"com.apple.product-type.app-extension"',
  };
  objs.PBXNativeTarget[`${targetUuid}_comment`] = TARGET_NAME;

  // "Embed App Extensions" copy phase on the app target (dstSubfolderSpec 13 = PlugIns).
  objs.PBXCopyFilesBuildPhase = objs.PBXCopyFilesBuildPhase || {};
  objs.PBXBuildFile[embedBuildFileUuid] = {
    isa: 'PBXBuildFile',
    fileRef: productRefUuid,
    fileRef_comment: `${TARGET_NAME}.appex`,
    settings: { ATTRIBUTES: ['RemoveHeadersOnCopy'] },
  };
  objs.PBXBuildFile[`${embedBuildFileUuid}_comment`] = `${TARGET_NAME}.appex in Embed App Extensions`;
  objs.PBXCopyFilesBuildPhase[embedPhaseUuid] = {
    isa: 'PBXCopyFilesBuildPhase',
    buildActionMask: 2147483647,
    dstPath: '""',
    dstSubfolderSpec: 13,
    files: [{ value: embedBuildFileUuid, comment: `${TARGET_NAME}.appex in Embed App Extensions` }],
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
    remoteInfo: `"${TARGET_NAME}"`,
  };
  objs.PBXTargetDependency = objs.PBXTargetDependency || {};
  objs.PBXTargetDependency[depUuid] = {
    isa: 'PBXTargetDependency',
    target: targetUuid,
    target_comment: TARGET_NAME,
    targetProxy: proxyUuid,
    targetProxy_comment: `PBXContainerItemProxy`,
  };
  appTarget.dependencies = appTarget.dependencies || [];
  appTarget.dependencies.push({ value: depUuid, comment: `PBXTargetDependency` });

  // Register with the project: target list + TargetAttributes.
  projectObj.targets.push({ value: targetUuid, comment: TARGET_NAME });
  projectObj.attributes = projectObj.attributes || {};
  projectObj.attributes.TargetAttributes = projectObj.attributes.TargetAttributes || {};
  projectObj.attributes.TargetAttributes[targetUuid] = {
    CreatedOnToolsVersion: '16.0',
    LastSwiftMigration: '1600',
  };
}

/** @type {import('@expo/config-plugins').ConfigPlugin} */
module.exports = function withDnsProxyTarget(config) {
  // The dns-proxy capability needs Apple's approval on the provisioning
  // profile (flag 89) — BM_IOS_DNSPROXY=0 strips the extension + its
  // entitlements for builds where the grant has not landed (TestFlight).
  if (process.env.BM_IOS_DNSPROXY === '0') return config;
  config = withAppEntitlements(config);
  config = copySources(config);
  config = withXcodeProject(config, (cfg) => {
    addExtensionTarget(cfg.modResults);
    return cfg;
  });
  return config;
};
