#import "WorkjetMarkdownTextRun.h"
#import "WorkjetMarkdownText.h"
#import "WorkjetMarkdownTextRunComponentDescriptor.h"
#import <react/renderer/components/WorkjetMarkdownTextSpec/EventEmitters.h>
#import <react/renderer/components/WorkjetMarkdownTextSpec/Props.h>
#import <react/renderer/components/WorkjetMarkdownTextSpec/RCTComponentViewHelpers.h>
#import "RCTFabricComponentsPlugins.h"
#import "Utils.h"

using namespace facebook::react;

@interface WorkjetMarkdownTextRun () <RCTWorkjetMarkdownTextRunViewProtocol>

@end

@implementation WorkjetMarkdownTextRun {
  NSString * _text;
  RCTBubblingEventBlock _onPress;
  RCTBubblingEventBlock _onLongPress;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
    return concreteComponentDescriptorProvider<WorkjetMarkdownTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const WorkjetMarkdownTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<WorkjetMarkdownTextRunProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<WorkjetMarkdownTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

- (void)onPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::WorkjetMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onPress(facebook::react::WorkjetMarkdownTextRunEventEmitter::OnPress{});
  }
}

- (void)onLongPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::WorkjetMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onLongPress(facebook::react::WorkjetMarkdownTextRunEventEmitter::OnLongPress{});
  }
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> WorkjetMarkdownTextRunCls(void)
{
    return WorkjetMarkdownTextRun.class;
}

@end
