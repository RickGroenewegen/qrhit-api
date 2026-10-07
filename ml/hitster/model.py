"""
The detector: MobileNetV3-Large (ImageNet weights, BSD licence via
torchvision) up to stride 32, a small top-down merge into stride 16, and a
head that gives every 16x16 cell a score per class. No boxes are regressed:
the cells that light up are where the mark is, which is all the designer needs
to point at it, and the highest cell per class is the verdict.

Fully convolutional, so any input size that is a multiple of 32 works; the
export fixes it at preprocess.SIZE.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
import torchvision

from marks import CLASSES


def conv_bn(cin, cout, k=1, groups=1):
    return nn.Sequential(
        nn.Conv2d(cin, cout, k, padding=k // 2, groups=groups, bias=False),
        nn.BatchNorm2d(cout),
        nn.Hardswish(),
    )


class Detector(nn.Module):
    def __init__(self, width: int = 96, pretrained: bool = True):
        super().__init__()
        weights = torchvision.models.MobileNet_V3_Large_Weights.IMAGENET1K_V2 if pretrained else None
        features = torchvision.models.mobilenet_v3_large(weights=weights).features
        self.to16 = features[:13]  # 112 channels, stride 16
        self.to32 = features[13:]  # 960 channels, stride 32
        self.lateral16 = conv_bn(112, width)
        self.lateral32 = conv_bn(960, width)
        self.head = nn.Sequential(
            conv_bn(width, width, 3, groups=width),
            conv_bn(width, width),
            conv_bn(width, width, 3, groups=width),
            conv_bn(width, width),
            nn.Conv2d(width, len(CLASSES), 1),
        )
        # Start every cell at "almost certainly nothing", so the many empty
        # cells do not swamp the first steps
        nn.init.constant_(self.head[-1].bias, -4.6)

    def forward(self, x):
        c16 = self.to16(x)
        c32 = self.to32(c16)
        p16 = self.lateral16(c16) + F.interpolate(self.lateral32(c32), scale_factor=2.0, mode="nearest")
        return self.head(p16)


class Exported(nn.Module):
    """What ships: probabilities per cell, (1, classes, H/16, W/16)."""

    def __init__(self, detector: Detector):
        super().__init__()
        self.detector = detector

    def forward(self, x):
        return torch.sigmoid(self.detector(x))
