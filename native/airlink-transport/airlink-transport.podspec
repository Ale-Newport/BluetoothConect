require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "airlink-transport"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.license      = "MIT"
  s.author       = { "AirLink" => "noreply@example.com" }
  s.homepage     = "https://example.com/airlink"
  # Track React Native's own floor rather than picking our own: every API this
  # pod uses (CoreBluetooth L2CAP, Network.framework, NEHotspotConfiguration)
  # has been available since well before it, and diverging only breaks the
  # dependency resolution.
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :path => "." }

  # Every Swift and ObjC++ file in ios/ is compiled. New transports are new
  # files in that folder - there is no project file to edit and nothing to
  # remember to register.
  s.source_files = "ios/**/*.{h,m,mm,swift}"

  # UserNotifications and AVFoundation are here for the two non-radio modules
  # that share this pod: local notifications and voice-message recording. They
  # live alongside the transports rather than in a pod of their own because
  # there is exactly one place the app links native code, and splitting that
  # into three would mean three podspecs and three codegen libraries to keep in
  # step for no gain.
  s.frameworks   = "CoreBluetooth", "Network", "NetworkExtension", "SystemConfiguration",
                   "UserNotifications", "AVFoundation"

  # Pulls in React-Core, the New Architecture headers, and the generated
  # AirLinkTransportSpec so the TurboModule protocol is visible.
  install_modules_dependencies(s)
end
