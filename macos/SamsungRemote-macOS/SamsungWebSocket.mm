//
//  SamsungWebSocket.mm
//  SamsungRemote
//
//  Created by Batu on 08.09.26.
//


#import <Foundation/Foundation.h>

#import <arpa/inet.h>
#import <netinet/in.h>
#import <stdint.h>
#import <string.h>
#import <sys/socket.h>
#import <unistd.h>

#import <React/RCTBridgeModule.h>
#import <React/RCTLog.h>

#import <SocketRocket/SRWebSocket.h>

static NSString *const SamsungRemoteClientNameKey =
  @"SamsungRemoteClientName";
static NSString *const SamsungRemoteTokenKey =
  @"SamsungRemoteAuthorizationToken";


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


- (NSString *)getOrCreateClientName
{
  NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
  NSString *clientName = [defaults stringForKey:SamsungRemoteClientNameKey];

  if (clientName.length > 0) {
    return clientName;
  }

  NSString *identifier =
    [[[NSUUID UUID].UUIDString substringToIndex:8] uppercaseString];
  clientName =
    [NSString stringWithFormat:@"SamsungRemote macOS %@", identifier];

  [defaults setObject:clientName forKey:SamsungRemoteClientNameKey];
  [defaults removeObjectForKey:SamsungRemoteTokenKey];
  RCTLogInfo(@"Created unique Samsung TV client identity");

  return clientName;
}


RCT_REMAP_METHOD(
  connect,
  connect:(NSString *)urlString
  resolver:(RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject
)
{
  NSURLComponents *components =
    [NSURLComponents componentsWithString:urlString];

  if (components == nil || components.URL == nil) {
    reject(@"INVALID_URL", @"Invalid WebSocket URL", nil);
    return;
  }

  NSString *clientName = [self getOrCreateClientName];
  NSString *encodedClientName =
    [[clientName dataUsingEncoding:NSUTF8StringEncoding]
      base64EncodedStringWithOptions:0];
  NSString *storedToken =
    [[NSUserDefaults standardUserDefaults]
      stringForKey:SamsungRemoteTokenKey];

  NSMutableArray<NSURLQueryItem *> *queryItems = [NSMutableArray array];
  for (NSURLQueryItem *item in components.queryItems ?: @[]) {
    if (![item.name isEqualToString:@"name"] &&
        ![item.name isEqualToString:@"token"]) {
      [queryItems addObject:item];
    }
  }

  [queryItems addObject:
    [NSURLQueryItem queryItemWithName:@"name" value:encodedClientName]];

  if (storedToken.length > 0) {
    [queryItems addObject:
      [NSURLQueryItem queryItemWithName:@"token" value:storedToken]];
  }

  components.queryItems = queryItems;
  NSURL *url = components.URL;

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

  RCTLogInfo(
    @"Opening Samsung WebSocket with %@",
    storedToken.length > 0 ? @"saved authorization" : @"pairing"
  );

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


RCT_REMAP_METHOD(
  wake,
  wake:(NSString *)macAddress
  broadcastAddress:(NSString *)broadcastAddress
  resolver:(RCTPromiseResolveBlock)resolve
  rejecter:(RCTPromiseRejectBlock)reject
)
{
  NSArray<NSString *> *parts =
    [macAddress componentsSeparatedByCharactersInSet:
      [NSCharacterSet characterSetWithCharactersInString:@":-"]];

  if (parts.count != 6) {
    reject(@"WAKE_FAILED", @"Invalid Samsung TV MAC address", nil);
    return;
  }

  uint8_t macBytes[6];
  for (NSUInteger index = 0; index < parts.count; index++) {
    unsigned int value = 0;
    NSScanner *scanner = [NSScanner scannerWithString:parts[index]];

    if (parts[index].length != 2 ||
        ![scanner scanHexInt:&value] ||
        !scanner.isAtEnd ||
        value > UINT8_MAX) {
      reject(@"WAKE_FAILED", @"Invalid Samsung TV MAC address", nil);
      return;
    }

    macBytes[index] = (uint8_t)value;
  }

  uint8_t magicPacket[102];
  memset(magicPacket, 0xFF, 6);
  for (NSUInteger repetition = 0; repetition < 16; repetition++) {
    memcpy(magicPacket + 6 + repetition * 6, macBytes, 6);
  }

  int socketDescriptor = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (socketDescriptor < 0) {
    reject(@"WAKE_FAILED", @"Could not create Wake-on-LAN socket", nil);
    return;
  }

  int broadcastEnabled = 1;
  if (setsockopt(
        socketDescriptor,
        SOL_SOCKET,
        SO_BROADCAST,
        &broadcastEnabled,
        sizeof(broadcastEnabled)
      ) < 0) {
    close(socketDescriptor);
    reject(@"WAKE_FAILED", @"Could not enable Wake-on-LAN broadcast", nil);
    return;
  }

  NSArray<NSString *> *destinations =
    @[broadcastAddress, @"255.255.255.255"];

  for (NSUInteger repetition = 0; repetition < 3; repetition++) {
    for (NSString *destination in destinations) {
      struct sockaddr_in address = {0};
      address.sin_family = AF_INET;
      address.sin_port = htons(9);

      if (inet_pton(
            AF_INET,
            destination.UTF8String,
            &address.sin_addr
          ) != 1) {
        close(socketDescriptor);
        reject(@"WAKE_FAILED", @"Invalid Wake-on-LAN broadcast address", nil);
        return;
      }

      ssize_t bytesSent = sendto(
        socketDescriptor,
        magicPacket,
        sizeof(magicPacket),
        0,
        (struct sockaddr *)&address,
        sizeof(address)
      );

      if (bytesSent != (ssize_t)sizeof(magicPacket)) {
        close(socketDescriptor);
        reject(@"WAKE_FAILED", @"Could not send Wake-on-LAN packet", nil);
        return;
      }
    }
  }

  close(socketDescriptor);
  RCTLogInfo(@"Wake-on-LAN packet sent");
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

  NSDictionary *message = (NSDictionary *)json;
  NSString *event = message[@"event"];
  RCTLogInfo(@"Received Samsung TV event: %@", event);

  // Samsung hat unseren Token akzeptiert.
  if ([event isEqualToString:@"ms.channel.connect"]) {

    id tokenValue =
      [message[@"data"] isKindOfClass:[NSDictionary class]]
        ? message[@"data"][@"token"]
        : nil;
    NSString *token =
      [tokenValue isKindOfClass:[NSString class]]
        ? tokenValue
        : [tokenValue respondsToSelector:@selector(stringValue)]
          ? [tokenValue stringValue]
          : nil;

    if (token.length > 0) {
      [[NSUserDefaults standardUserDefaults]
        setObject:token
           forKey:SamsungRemoteTokenKey];
      RCTLogInfo(@"Saved Samsung TV authorization token");
    }

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
