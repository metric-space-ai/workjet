#pragma once

#include "WorkjetMarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using WorkjetMarkdownTextComponentDescriptor = ConcreteComponentDescriptor<WorkjetMarkdownTextShadowNode>;

void WorkjetMarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
