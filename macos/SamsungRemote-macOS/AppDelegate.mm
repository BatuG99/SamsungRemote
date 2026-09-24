#import "AppDelegate.h"

#import <AppKit/AppKit.h>
#import <React/RCTBundleURLProvider.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
  self.moduleName = @"SamsungRemote";

  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};

  self.dependencyProvider = [RCTAppDependencyProvider new];

  // React Native erzeugt hier das eigentliche macOS-Fenster.
  [super applicationDidFinishLaunching:notification];

  // Danach holen wir uns genau dieses Fenster.
  NSWindow *window = NSApp.mainWindow;

  if (window != nil) {
    // Größe des nutzbaren Fensterinhalts.
    NSSize remoteSize = NSMakeSize(360, 640);

    [window setContentSize:remoteSize];

    // Fenster auf genau diese Größe begrenzen.
    window.contentMinSize = remoteSize;
    window.contentMaxSize = remoteSize;

    // Fenster mittig auf dem Bildschirm platzieren.
    [window center];

    // Manuelles Vergrößern/Verkleinern deaktivieren.
    window.styleMask &= ~NSWindowStyleMaskResizable;

    // Grünen Zoom-/Fullscreen-Button deaktivieren.
    NSButton *zoomButton =
      [window standardWindowButton:NSWindowZoomButton];

    zoomButton.enabled = NO;
  }
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings]
    jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle]
    URLForResource:@"main"
    withExtension:@"jsbundle"];
#endif
}

/// This method controls whether the `concurrentRoot` feature of React18 is turned on or off.
///
/// @see: https://reactjs.org/blog/2022/03/29/react-v18.html
/// @note: This requires to be rendering on Fabric
///        (i.e. on the New Architecture).
/// @return: `true` if the `concurrentRoot` feature is enabled.
///          Otherwise, it returns `false`.
- (BOOL)concurrentRootEnabled
{
#ifdef RN_FABRIC_ENABLED
  return true;
#else
  return false;
#endif
}

@end
