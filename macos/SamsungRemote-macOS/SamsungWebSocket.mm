//
//  SamsungWebSocket.h
//  SamsungRemote
//
//  Created by Batu on 08.09.26.
//


#import <Foundation/Foundation.h>

#import <React/RCTBridgeModule.h>
#import <React/RCTLog.h>

#import <SocketRocket/SRWebSocket.h>


@interface SamsungWebSocket : NSObject <RCTBridgeModule, SRWebSocketDelegate>

@property (nonatomic, strong) SRWebSocket *socket;

@property (nonatomic, copy) RCTPromiseResolveBlock connectResolve;
@property (nonatomic, copy) RCTPromiseRejectBlock connectReject;

@end


@implementation SamsungWebSocket

RCT_EXPORT_MODULE(SamsungWebSocket);


+ (BOOL)requiresMainQueueSetup
{
  return NO;
}


RCT_REMAP_METHOD(
  connect,
  connect:(NSString *)urlString
  resolver:(RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject
)
{
  NSURL *url = [NSURL URLWithString:urlString];

  if (url == nil) {
    reject(@"INVALID_URL", @"Invalid WebSocket URL", nil);
    return;
  }

  // Falls bereits eine Verbindung existiert:
  if (self.socket != nil) {
    self.socket.delegate = nil;
    [self.socket close];
    self.socket = nil;
  }

  self.connectResolve = resolve;
  self.connectReject = reject;

  NSURLRequest *request = [NSURLRequest requestWithURL:url];

  /*
   Samsung benutzt hier eine Zertifikatskette, der macOS nicht vertraut.
   Für genau diesen WebSocket erlauben wir deshalb untrusted certificates.

   Die verwendete SocketRocket-API ist deprecated, weil das allgemeine
   Abschalten der Zertifikatsprüfung normalerweise keine gute Idee ist.
   Für unseren lokalen Samsung-Prototypen tun wir es bewusst.
  */

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

  self.socket =
    [[SRWebSocket alloc]
      initWithURLRequest:request
      protocols:nil
      allowsUntrustedSSLCertificates:YES];

#pragma clang diagnostic pop

  self.socket.delegate = self;

  RCTLogInfo(@"Opening Samsung WebSocket: %@", urlString);

  [self.socket open];
}


RCT_REMAP_METHOD(
  send,
  send:(NSString *)message
  resolver:(RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject
)
{
  if (self.socket == nil || self.socket.readyState != SR_OPEN) {
    reject(@"NOT_CONNECTED", @"Samsung WebSocket is not open", nil);
    return;
  }

  NSError *error = nil;

  BOOL success = [self.socket sendString:message error:&error];

  if (!success || error != nil) {
    reject(
      @"SEND_FAILED",
      error.localizedDescription ?: @"Could not send WebSocket message",
      error
    );

    return;
  }

  resolve(@YES);
}


RCT_EXPORT_METHOD(close)
{
  self.connectResolve = nil;
  self.connectReject = nil;

  if (self.socket != nil) {
    [self.socket close];
    self.socket = nil;
  }
}


// ---------------------------------------------------------
// SocketRocket Delegate
// ---------------------------------------------------------

- (void)webSocketDidOpen:(SRWebSocket *)webSocket
{
  RCTLogInfo(@"Native WebSocket transport opened");
}


- (void)webSocket:(SRWebSocket *)webSocket
 didReceiveMessageWithString:(NSString *)string
{
  RCTLogInfo(@"Samsung TV -> %@", string);

  NSData *data = [string dataUsingEncoding:NSUTF8StringEncoding];

  if (data == nil) {
    return;
  }

  NSError *jsonError = nil;

  id json =
    [NSJSONSerialization JSONObjectWithData:data
                                    options:0
                                      error:&jsonError];

  if (jsonError != nil || ![json isKindOfClass:[NSDictionary class]]) {
    return;
  }

  NSString *event = ((NSDictionary *)json)[@"event"];

  // Samsung hat unseren Token akzeptiert.
  if ([event isEqualToString:@"ms.channel.connect"]) {

    if (self.connectResolve != nil) {
      self.connectResolve(@YES);

      self.connectResolve = nil;
      self.connectReject = nil;
    }

    return;
  }

  // Samsung hat uns nicht autorisiert.
  if ([event isEqualToString:@"ms.channel.unauthorized"]) {

    if (self.connectReject != nil) {
      self.connectReject(
        @"UNAUTHORIZED",
        @"Samsung TV rejected the WebSocket connection",
        nil
      );

      self.connectResolve = nil;
      self.connectReject = nil;
    }

    [webSocket close];
  }
}


- (void)webSocket:(SRWebSocket *)webSocket
 didFailWithError:(NSError *)error
{
  RCTLogInfo(@"Samsung WebSocket failed: %@", error.localizedDescription);

  if (self.connectReject != nil) {
    self.connectReject(
      @"CONNECTION_FAILED",
      error.localizedDescription,
      error
    );
  }

  self.connectResolve = nil;
  self.connectReject = nil;
  self.socket = nil;
}


- (void)webSocket:(SRWebSocket *)webSocket
 didCloseWithCode:(NSInteger)code
           reason:(NSString *)reason
         wasClean:(BOOL)wasClean
{
  RCTLogInfo(
    @"Samsung WebSocket closed. Code: %ld Reason: %@",
    (long)code,
    reason
  );

  // Falls connect() noch auf seine Antwort wartet:
  if (self.connectReject != nil) {

    NSString *message =
      [NSString stringWithFormat:
        @"WebSocket closed before authorization. Code: %ld",
        (long)code];

    self.connectReject(
      @"CONNECTION_CLOSED",
      message,
      nil
    );
  }

  self.connectResolve = nil;
  self.connectReject = nil;
  self.socket = nil;
}

@end