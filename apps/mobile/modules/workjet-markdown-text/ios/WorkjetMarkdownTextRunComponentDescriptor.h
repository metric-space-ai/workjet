#pragma once

#include "WorkjetMarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using WorkjetMarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<WorkjetMarkdownTextRunShadowNode>;

void WorkjetMarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
