## Build system first

Before running any build or touching build configuration, identify the project's actual build system and its documented entry point:

- Check for a documented build script (`build.sh`, `scripts/build-*.sh`, a README/agent-instructions note) before assuming `make` or `cmake --build` — do not guess invocations the project doesn't use. Prefer the project's own build flow over ad hoc `cmake`/`ninja` commands unless the script genuinely can't do what's needed.
- Note the generator and the pinned C++ standard (`CMAKE_CXX_STANDARD` in `CMakeLists.txt`, e.g. C++23). Do not introduce constructs outside the standard the project compiles with.

## Verify without launching the app

Many C++ engine/game projects keep runtime/UI verification manual. Validate through build success and the project's own test executables, not by launching a binary. When the tests are custom executables rather than gtest/Catch2, find the test targets under `tests/` and run them the way the project does.

## Compiler warnings

Build with the project's warning configuration (check `CMakeLists.txt` / compile options for `-Wall -Wextra` or stricter) and treat new warnings on files you touched as review findings, not noise. Do not silence warnings unless the project's own config already does.

## Memory ownership

Match the project's ownership convention — raw pointers + manual lifetime, `std::unique_ptr`/`std::shared_ptr`, or a custom allocator/arena — before introducing a new allocation pattern. A pattern that is idiomatic in isolation but inconsistent with the surrounding code is a review finding.

## Headers and rebuild cost

Check whether a header you're changing is included by many translation units before adding heavy includes to it. Prefer forward declarations and moving heavy includes into `.cpp` files to avoid an avoidable full rebuild.

## ABI / link compatibility

Changing a class's layout in a header used across a shared-library boundary (adding/removing members, changing virtual functions) compiles fine locally but breaks only at link/load time. Check whether the type crosses a library boundary before changing its layout.

## Project docs

C++ engine/game projects often carry living design docs (`docs/`, `wiki/`). Scan them before touching a subsystem — they encode decisions already made and prevent redoing settled analysis.
