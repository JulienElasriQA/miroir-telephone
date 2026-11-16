// Dessine l'icône de l'app (PNG 1024×1024) : dégradé indigo → cyan, téléphone qui « diffuse » et pastille d'enregistrement.
// Usage : osascript -l JavaScript scripts/make-icon.js sortie.png
ObjC.import('Cocoa')

function run(argv) {
  const S = 1024
  const rect = (x, y, w, h) => $.NSMakeRect(x, y, w, h)
  const rgb = (r, g, b) => $.NSColor.colorWithSRGBRedGreenBlueAlpha(r / 255, g / 255, b / 255, 1)

  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, S, S, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0)
  $.NSGraphicsContext.saveGraphicsState
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep))

  // Fond : gabarit d'icône macOS (carré arrondi de 824 px centré)
  const bg = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(rect(100, 100, 824, 824), 185, 185)
  $.NSGradient.alloc.initWithStartingColorEndingColor(rgb(6, 182, 212), rgb(79, 70, 229)).drawInBezierPathAngle(bg, 90)

  // Symbole téléphone en blanc
  let sym = $.NSImage.imageWithSystemSymbolNameAccessibilityDescription('iphone.gen3.radiowaves.left.and.right', $())
  if (sym.isNil()) sym = $.NSImage.imageWithSystemSymbolNameAccessibilityDescription('iphone.radiowaves.left.and.right', $())
  sym = sym.imageWithSymbolConfiguration($.NSImageSymbolConfiguration.configurationWithPointSizeWeight(400, 0.23))
  const sz = sym.size
  const white = $.NSImage.alloc.initWithSize(sz)
  white.lockFocus
  sym.drawInRect(rect(0, 0, sz.width, sz.height))
  $.NSColor.whiteColor.set
  $.NSRectFillUsingOperation(rect(0, 0, sz.width, sz.height), 5 /* source atop */)
  white.unlockFocus
  const k = Math.min(620 / sz.width, 500 / sz.height)
  const w = sz.width * k, h = sz.height * k
  white.drawInRectFromRectOperationFraction(rect(512 - w / 2, 560 - h / 2, w, h), $.NSZeroRect, 2, 1)

  // Pastille « REC »
  $.NSColor.whiteColor.setFill
  $.NSBezierPath.bezierPathWithOvalInRect(rect(624, 150, 210, 210)).fill
  rgb(255, 59, 48).setFill
  $.NSBezierPath.bezierPathWithOvalInRect(rect(650, 176, 158, 158)).fill

  $.NSGraphicsContext.restoreGraphicsState
  rep.representationUsingTypeProperties(4 /* PNG */, $()).writeToFileAtomically(argv[0], true)
}
