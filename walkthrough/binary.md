# Binary stays binary

Apps and macOS keep many plists in the binary format (`bplist00`). Most editors show them as unreadable bytes or turn them into XML.

Here a binary plist opens as the same tree as an XML one, and Save writes it back as binary. An XML plist is saved as XML with its own indent, so a one-line change stays a one-line change in git.

Show XML puts a readable XML copy next to the tree that follows every edit. Save a Copy As writes XML, binary, JSON or OpenStep.
