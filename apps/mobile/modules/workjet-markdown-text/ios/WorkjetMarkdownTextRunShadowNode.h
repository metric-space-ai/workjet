#pragma once

#include <react/renderer/components/WorkjetMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/WorkjetMarkdownTextSpec/Props.h>
#include <react/renderer/components/WorkjetMarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char WorkjetMarkdownTextRunComponentName[];

using WorkjetMarkdownTextRunShadowNode = ConcreteViewShadowNode<
    WorkjetMarkdownTextRunComponentName,
    WorkjetMarkdownTextRunProps,
    WorkjetMarkdownTextRunEventEmitter,
    WorkjetMarkdownTextRunState>;
}
