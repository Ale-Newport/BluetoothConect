require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "airlink-transport"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.license      = "MIT"
  s.author       = { "AirLink" => "noreply@example.com" }
  s.homepage     = "https://example.com/airlink"
  s.platforms    = { :ios => "16.0" }
  s.source       = { :path => "." }

  # Every Swift and ObjC++ file in ios/ is compiled. New transports are new
  # files in that folder - there is no project file to edit and nothing to
  # remember to register.
  s.source_files = "ios/**/*.{h,m,mm,swift}"

  s.frameworks   = "CoreBluetooth", "Network", "NetworkExtension", "SystemConfiguration"

  # Pulls in React-Core, the New Architecture headers, and the generated
  # AirLinkTransportSpec so the TurboModule protocol is visible.
  install_modules_dependencies(s)
end
