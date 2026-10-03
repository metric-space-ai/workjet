#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface WorkjetMarkdownTextManager : RCTViewManager
@end

@implementation WorkjetMarkdownTextManager

RCT_EXPORT_MODULE(WorkjetMarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface WorkjetMarkdownTextRunManager : RCTViewManager
@end

@implementation WorkjetMarkdownTextRunManager

RCT_EXPORT_MODULE(WorkjetMarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
