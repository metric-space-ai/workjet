#pragma once

#include <react/renderer/components/WorkjetMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/WorkjetMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char WorkjetMarkdownTextComponentName[];

struct WorkjetMarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct WorkjetMarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
};

inline Float WorkjetMarkdownTextAttachmentSize(const WorkjetMarkdownTextAttachmentRange &) {
  return 14;
}

inline Float WorkjetMarkdownTextAttachmentBaselineOffset(
    const WorkjetMarkdownTextAttachmentRange &) {
  return -2;
}

class WorkjetMarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<WorkjetMarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<WorkjetMarkdownTextAttachmentRange> attachmentRanges;
};

class WorkjetMarkdownTextShadowNode final : public ConcreteViewShadowNode<
WorkjetMarkdownTextComponentName,
WorkjetMarkdownTextProps,
WorkjetMarkdownTextEventEmitter,
WorkjetMarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  WorkjetMarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<WorkjetMarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<WorkjetMarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
