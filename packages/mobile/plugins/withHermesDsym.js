// @ts-check
/**
 * `hermesvm.framework` embeds as a dynamic framework, and exportArchive's
 * "Upload Symbols" step warns "the archive did not include a dSYM for
 * hermesvm.framework". Cause: the hermes-engine pod vendors Meta's PREBUILT
 * hermesvm.xcframework, which ships without dSYMs — Meta publishes them as a
 * separate `hermes-framework-dSYM-{debug,release}` tarball on Maven that
 * podspec never fetches (upstream gap; replace_hermes_version.js swaps only
 * the framework tarballs).
 *
 * The merge lands in post_install: fetch the release dSYM tarball matching
 * the pod's version once (cached under node_modules/.cache — Pods/ is wiped
 * by `expo prebuild --clean`), drop each iOS slice's dSYM into
 * <slice>/dSYMs/, and mark DebugSymbolsPath in the xcframework plist. Xcode
 * then collects it into the archive's dSYMs/ like any vendored symbols —
 * verified locally: UUID 7A1DA64A… matches the shipped binary.
 */
const { withPodfile } = require('@expo/config-plugins');

const DSYM_SNIPPET = `
    # Merge Meta's published hermesvm dSYMs into the vendored prebuilt
    # xcframework — the tarball ships no symbols, so archives warn at upload.
    hermes_xcf = File.join(installer.sandbox.root, 'hermes-engine/destroot/Library/Frameworks/universal/hermesvm.xcframework')
    if File.exist?(hermes_xcf) && !File.exist?(File.join(hermes_xcf, 'ios-arm64/dSYMs/hermesvm.framework.dSYM'))
      hermes_version = installer.sandbox.specification('hermes-engine')&.version&.to_s
      cache = File.join(installer.sandbox.root, '../../../node_modules/.cache/bm-hermes-dsym')
      FileUtils.mkdir_p(cache)
      tarball = File.join(cache, "hermes-dsym-release-\#{hermes_version}.tar.gz")
      unless hermes_version && !hermes_version.empty?
        Pod::UI.warn 'withHermesDsym: could not resolve hermes-engine version — skipping dSYM merge'
      else
        unless File.exist?(tarball)
          urls = [
            "https://repo1.maven.org/maven2/com/facebook/hermes/hermes-ios/\#{hermes_version}/hermes-ios-\#{hermes_version}-hermes-framework-dSYM-release.tar.gz",
            "https://repo.reactnative.dev/maven2/com/facebook/hermes/hermes-ios/\#{hermes_version}/hermes-ios-\#{hermes_version}-hermes-framework-dSYM-release.tar.gz",
          ]
          urls.each do |url|
            break if File.exist?(tarball)
            system('curl', '-fsSL', '--connect-timeout', '20', url, '-o', tarball)
          end
          File.delete(tarball) if File.exist?(tarball) && File.size(tarball) < 1024
        end
        # Seed the build phase's cache — replace_hermes_version.js re-extracts
        # the plain tarball on any configuration swap and must re-merge without
        # a second 371MB download (see scripts/patch-react-native-hermes-dsym.cjs).
        artifacts = File.join(installer.sandbox.root, 'hermes-engine-artifacts')
        FileUtils.mkdir_p(artifacts)
        FileUtils.cp(tarball, File.join(artifacts, "hermes-ios-\#{hermes_version}-hermes-framework-dSYM-release.tar.gz")) if File.exist?(tarball)
        extract = File.join(cache, 'iphoneos-slices')
        FileUtils.mkdir_p(extract)
        if File.exist?(tarball) && system('tar', '-xzf', tarball, '-C', extract, 'iphoneos', 'iphonesimulator')
          plist = File.join(hermes_xcf, 'Info.plist')
          { 'iphoneos' => 'ios-arm64', 'iphonesimulator' => 'ios-arm64_x86_64-simulator' }.each do |platform, slice|
            dsym_src = File.join(extract, platform, 'hermesvm.framework.dSYM')
            slice_dir = File.join(hermes_xcf, slice)
            next unless File.exist?(dsym_src) && File.directory?(slice_dir)
            FileUtils.mkdir_p(File.join(slice_dir, 'dSYMs'))
            FileUtils.cp_r(dsym_src, File.join(slice_dir, 'dSYMs'))
            idx = 0
            loop do
              id = \`/usr/libexec/PlistBuddy -c "Print :AvailableLibraries:\#{idx}:LibraryIdentifier" "\#{plist}" 2>/dev/null\`.strip
              break if id.empty?
              if id == slice && !system('/usr/libexec/PlistBuddy', '-c', "Print :AvailableLibraries:\#{idx}:DebugSymbolsPath", plist, [:out, :err] => File::NULL)
                system('/usr/libexec/PlistBuddy', '-c', "Add :AvailableLibraries:\#{idx}:DebugSymbolsPath string dSYMs", plist)
              end
              idx += 1
            end
          end
          Pod::UI.puts 'withHermesDsym: merged hermesvm.framework.dSYM into the vendored xcframework'
        else
          Pod::UI.warn 'withHermesDsym: dSYM tarball unavailable — archives will keep the missing-dSYM warning'
        end
      end
    end
`;

/** @type {import('@expo/config-plugins').ConfigPlugin} */
module.exports = function withHermesDsym(config) {
  return withPodfile(config, (cfg) => {
    if (!cfg.modResults.contents.includes('withHermesDsym: merged')) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /(post_install do \|installer\|[\s\S]*?react_native_post_install\([\s\S]*?\n    \)\n)/,
        `$1${DSYM_SNIPPET}`
      );
    }
    return cfg;
  });
};
